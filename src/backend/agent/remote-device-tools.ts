import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  RemoteDeviceCommandAgentTarget,
  RemoteDeviceCommandResult,
  RemoteDeviceCommandTargetInput,
  RemoteDeviceComputerUseCallInput,
  RemoteDeviceComputerUseResult,
  RemoteDeviceComputerUseTool,
  RunRemoteDeviceCommandInput,
} from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import { z } from "zod";

export interface RemoteDeviceCommandToolClient {
  listTargetsForAgent(agentId: string): Promise<RemoteDeviceCommandAgentTarget[]>;
  run(input: RunRemoteDeviceCommandInput): Promise<RemoteDeviceCommandResult>;
  listComputerUseTools(input: RemoteDeviceCommandTargetInput): Promise<RemoteDeviceComputerUseTool[]>;
  callComputerUse(input: RemoteDeviceComputerUseCallInput): Promise<RemoteDeviceComputerUseResult>;
}

export const runRemoteCommandSchema = z.object({
  serverId: z.string().min(1).max(INPUT_LIMITS.identifier),
  executable: z.string().min(1).max(128),
  args: z.array(z.string().max(4_096)).max(64),
  workingDirectory: z.string().min(1).max(INPUT_LIMITS.path),
});

export const remoteComputerUseToolsSchema = z.object({
  serverId: z.string().min(1).max(INPUT_LIMITS.identifier),
});

export const remoteComputerUseCallSchema = z.object({
  serverId: z.string().min(1).max(INPUT_LIMITS.identifier),
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()),
});

export const REMOTE_DEVICE_TOOL_DEFINITIONS = [
  {
    name: "list_remote_devices",
    description:
      "List online Windows/Linux OpenBot servers that you can operate, and your current per-device command and Computer Use grants. A grant is off unless the user enabled it in Settings.",
    shape: {},
  },
  {
    name: "run_remote_command",
    description:
      "Run one allowlisted executable on a named remote device without a shell. The target host checks its per-agent permission and blocks high-risk commands with AutoReview. Use only for the user's requested task. Never try to bypass a block or widen a grant.",
    shape: runRemoteCommandSchema.shape,
  },
  {
    name: "list_remote_computer_use_tools",
    description:
      "List the Computer Use tools exposed by one remote device. The target host rejects this unless the user enabled Computer Use for you on that device.",
    shape: remoteComputerUseToolsSchema.shape,
  },
  {
    name: "remote_computer_use",
    description:
      "Call one Computer Use tool on a named remote device. The target host checks its separate per-agent Computer Use grant. This operates in the background with the target's OpenBot driver and must not bypass user consent or policy blocks.",
    shape: remoteComputerUseCallSchema.shape,
  },
] as const;

export function isRemoteDeviceTool(tool: string): boolean {
  return REMOTE_DEVICE_TOOL_DEFINITIONS.some((definition) => definition.name === tool);
}

export async function callRemoteDeviceTool(
  tool: string,
  args: unknown,
  agentId: string,
  client: RemoteDeviceCommandToolClient | null,
): Promise<{
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>;
}> {
  if (!client) {
    return failure("Remote device operations are unavailable on this server.");
  }
  try {
    if (tool === "list_remote_devices") {
      return success(await client.listTargetsForAgent(agentId));
    }
    if (tool === "run_remote_command") {
      const input = runRemoteCommandSchema.parse(args);
      const result = await client.run({ ...input, agentId });
      return success({ ...result, stdout: redactText(result.stdout), stderr: redactText(result.stderr) });
    }
    if (tool === "list_remote_computer_use_tools") {
      const input = remoteComputerUseToolsSchema.parse(args);
      return success(await client.listComputerUseTools({ ...input, agentId }));
    }
    if (tool === "remote_computer_use") {
      const input = remoteComputerUseCallSchema.parse(args);
      return await client.callComputerUse({ ...input, agentId });
    }
    return failure("Unknown remote device tool.");
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? `Invalid arguments: ${error.issues[0]?.message ?? "check the fields"}`
        : error instanceof Error
          ? redactText(error.message)
          : "The remote device request failed.";
    return failure(message.slice(0, 4_096));
  }
}

function success(value: unknown) {
  return { success: true, contentItems: [{ type: "inputText" as const, text: JSON.stringify(value) }] };
}

function failure(message: string) {
  return { success: false, contentItems: [{ type: "inputText" as const, text: message }] };
}
