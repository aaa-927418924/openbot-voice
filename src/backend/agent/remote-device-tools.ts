import { createHash, randomUUID } from "node:crypto";
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
import { createOpenBotLogger, redactText } from "@openbot/logging";
import { z } from "zod";

const logger = createOpenBotLogger("remote-device-tools");
const REMOTE_COMPUTER_USE_MAX_CALLS_PER_TURN = 20;
const REMOTE_COMPUTER_USE_MAX_DURATION_MS = 4 * 60_000;
const REMOTE_COMPUTER_USE_BUDGET_TTL_MS = 15 * 60_000;

type RemoteComputerUseStopReason = "call_limit" | "time_limit" | "repeated_failures";

interface RemoteComputerUseTurnBudget {
  startedAt: number;
  lastUsedAt: number;
  calls: number;
  consecutiveFailures: number;
  stopReason: RemoteComputerUseStopReason | null;
  stopLogged: boolean;
}

const remoteComputerUseTurnBudgets = new Map<string, RemoteComputerUseTurnBudget>();

function diagnosticTag(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export interface RemoteDeviceCommandToolClient {
  listTargetsForAgent(agentId: string, operationId?: string): Promise<RemoteDeviceCommandAgentTarget[]>;
  run(input: RunRemoteDeviceCommandInput, operationId?: string): Promise<RemoteDeviceCommandResult>;
  listComputerUseTools(
    input: RemoteDeviceCommandTargetInput,
    operationId?: string,
  ): Promise<RemoteDeviceComputerUseTool[]>;
  callComputerUse(
    input: RemoteDeviceComputerUseCallInput,
    operationId?: string,
  ): Promise<RemoteDeviceComputerUseResult>;
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
      "List online Windows/Linux devices shared by this account. Each name is the target computer's operating-system device name followed by its OS, not its OpenBot server name. Include device-wide command and Computer Use permissions and whether local deterministic command review is available; a null policy means the device is visible but its grants could not be read. Match OS-only references such as ‘Windows PC’ against the platform field; if exactly one target matches, use that device, and if multiple targets match, ask which one. If empty, explain that the target PC must turn on remote device sharing in OpenBot Settings; it does not need to be a regular OpenBot server.",
    shape: {},
  },
  {
    name: "run_remote_command",
    description:
      "Run one requested command on the device selected by serverId from list_remote_devices. The listed device name uses the computer's operating-system device name followed by its OS; the local OpenBot server name is not the device identity. When the user identifies the device only by OS, use it only if exactly one listed device has that OS; otherwise ask which device. The target applies a local deterministic safety review without a model call: it permits a small set of read-only system commands and restricted PowerShell file-listing pipelines, and blocks scripts, unknown commands, and destructive operations. For a Windows file-size listing, use powershell.exe with -NoProfile -NonInteractive -Command and a direct Get-ChildItem pipeline limited to Sort-Object Length/Name and Select-Object Name,FullName,Length,LastWriteTime; use $env:USERPROFILE\\Downloads as the path. If the local review blocks a command, do not retry it with a workaround. Use Computer Use for other operations when that separate permission is enabled.",
    shape: runRemoteCommandSchema.shape,
  },
  {
    name: "list_remote_computer_use_tools",
    description:
      "List Computer Use tools exposed by one remote device. The target rejects this unless the device-wide Computer Use permission is enabled.",
    shape: remoteComputerUseToolsSchema.shape,
  },
  {
    name: "remote_computer_use",
    description:
      "Call one Computer Use tool on a named remote device. The target checks its device-wide Computer Use permission. This operates with the target's OpenBot driver and must not bypass user consent or policy blocks. Keep the task focused and use no more than 20 calls or 4 minutes per user turn. After a budget warning, do not call Computer Use again; summarize what worked and what remains. After two consecutive failed actions, stop and report the blocker.",
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
  turnId: string,
): Promise<{
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>;
}> {
  const operationId = randomUUID();
  const loggedTool = REMOTE_DEVICE_TOOL_DEFINITIONS.some((definition) => definition.name === tool) ? tool : "unknown";
  logger.info("Remote device agent tool started.", {
    operationId,
    tool: loggedTool,
    agentTag: diagnosticTag(agentId),
  });
  if (!client) {
    logger.warn("Remote device agent tool has no client.", {
      operationId,
      tool: loggedTool,
      agentTag: diagnosticTag(agentId),
    });
    return failure("Remote device operations are unavailable on this server.");
  }
  try {
    if (tool === "list_remote_devices") {
      const targets = await client.listTargetsForAgent(agentId, operationId);
      logger.info("Remote device agent list returned.", {
        operationId,
        agentTag: diagnosticTag(agentId),
        targetCount: targets.length,
        windowsCount: targets.filter((target) => target.platform === "windows").length,
        linuxCount: targets.filter((target) => target.platform === "linux").length,
        policyUnavailableCount: targets.filter((target) => target.policy === null).length,
      });
      return success(targets);
    }
    if (tool === "run_remote_command") {
      const input = runRemoteCommandSchema.parse(args);
      logger.info("Remote device command tool target selected.", {
        operationId,
        agentTag: diagnosticTag(agentId),
        serverTag: diagnosticTag(input.serverId),
        argumentNames: Object.keys(input).filter((key) => key !== "serverId"),
      });
      const result = await client.run({ ...input, agentId }, operationId);
      logger.info("Remote device command tool completed.", {
        operationId,
        agentTag: diagnosticTag(agentId),
        serverTag: diagnosticTag(input.serverId),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });
      return success({ ...result, stdout: redactText(result.stdout), stderr: redactText(result.stderr) });
    }
    if (tool === "list_remote_computer_use_tools") {
      const input = remoteComputerUseToolsSchema.parse(args);
      const tools = await client.listComputerUseTools({ serverId: input.serverId }, operationId);
      logger.info("Remote Computer Use tool list returned.", {
        operationId,
        agentTag: diagnosticTag(agentId),
        serverTag: diagnosticTag(input.serverId),
        toolCount: tools.length,
      });
      return success(tools);
    }
    if (tool === "remote_computer_use") {
      const input = remoteComputerUseCallSchema.parse(args);
      const budget = reserveRemoteComputerUseBudget(turnId);
      if (!budget.allowed) {
        const reasonText =
          budget.reason === "call_limit"
            ? `the ${REMOTE_COMPUTER_USE_MAX_CALLS_PER_TURN}-call limit`
            : budget.reason === "time_limit"
              ? "the four-minute time limit"
              : "two consecutive failed actions";
        if (budget.shouldLog) {
          logger.warn("Remote Computer Use stopped for this turn.", {
            operationId,
            agentTag: diagnosticTag(agentId),
            callCount: budget.callCount,
            elapsedMs: budget.elapsedMs,
            stopReason: budget.reason,
          });
        }
        return failure(
          `Remote Computer Use stopped after reaching ${reasonText}. Do not make another remote Computer Use call in this turn. Summarize what worked and what remains.`,
        );
      }

      let result: RemoteDeviceComputerUseResult;
      try {
        result = await client.callComputerUse({ ...input, agentId }, operationId);
      } catch (error) {
        recordRemoteComputerUseFailure(turnId);
        throw error;
      }
      const consecutiveFailures = recordRemoteComputerUseResult(turnId, result.success);
      logger.info("Remote Computer Use tool call completed.", {
        operationId,
        agentTag: diagnosticTag(agentId),
        serverTag: diagnosticTag(input.serverId),
        computerUseTool: input.tool,
        callCount: budget.callCount,
        turnElapsedMs: budget.elapsedMs,
        consecutiveFailures,
        succeeded: result.success,
      });
      return result;
    }
    return failure("Unknown remote device tool.");
  } catch (error) {
    logger.warn("Remote device agent tool failed.", {
      operationId,
      tool: loggedTool,
      agentTag: diagnosticTag(agentId),
      failureKind: error instanceof z.ZodError ? "invalid_arguments" : "request_failed",
    });
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

function reserveRemoteComputerUseBudget(
  turnId: string,
  now = Date.now(),
):
  | { allowed: true; callCount: number; elapsedMs: number }
  | {
      allowed: false;
      callCount: number;
      elapsedMs: number;
      reason: RemoteComputerUseStopReason;
      shouldLog: boolean;
    } {
  for (const [activeTurnId, budget] of remoteComputerUseTurnBudgets) {
    if (now - budget.lastUsedAt > REMOTE_COMPUTER_USE_BUDGET_TTL_MS) {
      remoteComputerUseTurnBudgets.delete(activeTurnId);
    }
  }
  let budget = remoteComputerUseTurnBudgets.get(turnId);
  if (!budget) {
    budget = {
      startedAt: now,
      lastUsedAt: now,
      calls: 0,
      consecutiveFailures: 0,
      stopReason: null,
      stopLogged: false,
    };
    remoteComputerUseTurnBudgets.set(turnId, budget);
  }
  budget.lastUsedAt = now;
  const elapsedMs = now - budget.startedAt;
  if (!budget.stopReason) {
    if (elapsedMs >= REMOTE_COMPUTER_USE_MAX_DURATION_MS) budget.stopReason = "time_limit";
    else if (budget.calls >= REMOTE_COMPUTER_USE_MAX_CALLS_PER_TURN) budget.stopReason = "call_limit";
  }
  if (budget.stopReason) {
    const shouldLog = !budget.stopLogged;
    budget.stopLogged = true;
    return { allowed: false, callCount: budget.calls, elapsedMs, reason: budget.stopReason, shouldLog };
  }
  budget.calls += 1;
  return { allowed: true, callCount: budget.calls, elapsedMs };
}

function recordRemoteComputerUseResult(turnId: string, succeeded: boolean): number {
  const budget = remoteComputerUseTurnBudgets.get(turnId);
  if (!budget) return 0;
  budget.lastUsedAt = Date.now();
  budget.consecutiveFailures = succeeded ? 0 : budget.consecutiveFailures + 1;
  if (budget.consecutiveFailures >= 2) budget.stopReason = "repeated_failures";
  return budget.consecutiveFailures;
}

function recordRemoteComputerUseFailure(turnId: string): void {
  recordRemoteComputerUseResult(turnId, false);
}
