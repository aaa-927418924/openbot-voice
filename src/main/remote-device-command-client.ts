import type {
  RemoteDeviceCommandAgentTarget,
  RemoteDeviceCommandInput,
  RemoteDeviceCommandPermission,
  RemoteDeviceCommandResult,
  RemoteDeviceCommandTarget,
  RemoteDeviceCommandTargetInput,
  RemoteDeviceComputerUseCallInput,
  RemoteDeviceComputerUseContentItem,
  RemoteDeviceComputerUseResult,
  RemoteDeviceComputerUseTool,
  UpdateRemoteDeviceCommandTargetInput,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { DEVICE_COMMAND_ROUTES, DEVICE_COMMANDS_CAPABILITY } from "@openbot/contracts/team-protocol/device-commands-v1";
import { runCauseEffect } from "../backend/effect-boundary";
import type { ResponseDecoder } from "./remote-host-decoding";
import type { RemoteServerManager } from "./remote-server-manager";

type RemoteRequestOptions = Pick<RemoteServerManager, "list" | "request" | "supportsCapability">;

interface DeviceCommandTargetInfo {
  serverId: string;
  name: string;
  platform: "windows" | "linux";
  computerUseAvailable: boolean;
}

function decodeTargetInfo(value: unknown): DeviceCommandTargetInfo {
  if (
    !isDynamicRecord(value) ||
    !identifier(value.serverId) ||
    !isString(value.name) ||
    value.name.length > 128 ||
    (value.platform !== "windows" && value.platform !== "linux") ||
    typeof value.computerUseAvailable !== "boolean"
  ) {
    throw new Error("Invalid remote device information.");
  }
  return {
    serverId: value.serverId,
    name: value.name,
    platform: value.platform,
    computerUseAvailable: value.computerUseAvailable,
  };
}

function decodePermission(value: unknown): RemoteDeviceCommandPermission {
  if (
    !isDynamicRecord(value) ||
    !identifier(value.agentId) ||
    typeof value.commandsEnabled !== "boolean" ||
    typeof value.computerUseEnabled !== "boolean" ||
    !stringList(value.allowedExecutables, 64, 128) ||
    !stringList(value.allowedDirectories, 32, 4_096) ||
    !(value.updatedAt === null || isString(value.updatedAt))
  ) {
    throw new Error("Invalid remote device permission response.");
  }
  return {
    agentId: value.agentId,
    commandsEnabled: value.commandsEnabled,
    computerUseEnabled: value.computerUseEnabled,
    allowedExecutables: [...value.allowedExecutables],
    allowedDirectories: [...value.allowedDirectories],
    updatedAt: value.updatedAt,
  };
}

function decodeCommandResult(value: unknown): RemoteDeviceCommandResult {
  if (
    !isDynamicRecord(value) ||
    !(value.exitCode === null || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode))) ||
    !isString(value.stdout) ||
    value.stdout.length > 65_536 ||
    !isString(value.stderr) ||
    value.stderr.length > 65_536 ||
    typeof value.durationMs !== "number" ||
    !Number.isSafeInteger(value.durationMs) ||
    value.durationMs < 0 ||
    typeof value.timedOut !== "boolean"
  ) {
    throw new Error("Invalid remote command response.");
  }
  return {
    exitCode: value.exitCode,
    stdout: value.stdout,
    stderr: value.stderr,
    durationMs: value.durationMs,
    timedOut: value.timedOut,
  };
}

function decodeComputerUseTools(value: unknown): { tools: RemoteDeviceComputerUseTool[] } {
  if (!isDynamicRecord(value) || !Array.isArray(value.tools) || value.tools.length > 128) {
    throw new Error("Invalid remote Computer Use tool list.");
  }
  return {
    tools: value.tools.map((tool) => {
      if (
        !isDynamicRecord(tool) ||
        !isString(tool.name) ||
        tool.name.length > 128 ||
        !isString(tool.description) ||
        tool.description.length > 2_048
      ) {
        throw new Error("Invalid remote Computer Use tool.");
      }
      return { name: tool.name, description: tool.description };
    }),
  };
}

function decodeComputerUseResult(value: unknown): RemoteDeviceComputerUseResult {
  if (!isDynamicRecord(value) || typeof value.success !== "boolean" || !Array.isArray(value.contentItems)) {
    throw new Error("Invalid remote Computer Use response.");
  }
  const contentItems: RemoteDeviceComputerUseContentItem[] = value.contentItems.map((item) => {
    if (isDynamicRecord(item) && item.type === "inputText" && isString(item.text) && item.text.length <= 65_536) {
      return { type: "inputText", text: item.text };
    }
    if (
      isDynamicRecord(item) &&
      item.type === "inputImage" &&
      isString(item.imageUrl) &&
      item.imageUrl.length <= 5_600_000
    ) {
      return { type: "inputImage", imageUrl: item.imageUrl };
    }
    throw new Error("Invalid remote Computer Use content item.");
  });
  if (contentItems.length > 8) throw new Error("Remote Computer Use returned too many content items.");
  return { success: value.success, contentItems };
}

function identifier(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= 128;
}

function stringList(value: unknown, maximumCount: number, maximumLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumCount &&
    value.every((entry) => isString(entry) && entry.length > 0 && entry.length <= maximumLength)
  );
}

/** Routes owner-controlled device policies and agent operations to registered Windows/Linux hosts. */
export class RemoteDeviceCommandClient {
  readonly #servers: RemoteRequestOptions;

  constructor(servers: RemoteRequestOptions) {
    this.#servers = servers;
  }

  async listTargets(): Promise<RemoteDeviceCommandTarget[]> {
    const result: RemoteDeviceCommandTarget[] = [];
    for (const server of this.#servers.list()) {
      if (
        server.kind !== "remote" ||
        server.state !== "online" ||
        !this.#servers.supportsCapability(server.id, DEVICE_COMMANDS_CAPABILITY)
      ) {
        continue;
      }
      try {
        const info = await this.#request(server.id, DEVICE_COMMAND_ROUTES.info, decodeTargetInfo);
        result.push({ ...info, state: server.state });
      } catch {
        // A server can disconnect between the summary and this request. Keep the rest of the list usable.
      }
    }
    return result;
  }

  async listTargetsForAgent(agentId: string): Promise<RemoteDeviceCommandAgentTarget[]> {
    const result: RemoteDeviceCommandAgentTarget[] = [];
    for (const target of await this.listTargets()) {
      try {
        const permission = await this.getPermission({ serverId: target.serverId, agentId });
        result.push({ ...target, permission });
      } catch {
        // The caller still sees targets whose policy can be read. No denied grant is inferred as enabled.
      }
    }
    return result;
  }

  getPermission(input: RemoteDeviceCommandTargetInput): Promise<RemoteDeviceCommandPermission> {
    const path = `${DEVICE_COMMAND_ROUTES.permissions}?agentId=${encodeURIComponent(input.agentId)}`;
    return this.#request(input.serverId, path, decodePermission);
  }

  updatePermission(input: UpdateRemoteDeviceCommandTargetInput): Promise<RemoteDeviceCommandPermission> {
    return this.#request(input.serverId, DEVICE_COMMAND_ROUTES.updatePermissions, decodePermission, {
      method: "POST",
      body: input.permission,
    });
  }

  run(input: RemoteDeviceCommandInput & { serverId: string }): Promise<RemoteDeviceCommandResult> {
    return this.#request(input.serverId, DEVICE_COMMAND_ROUTES.run, decodeCommandResult, {
      method: "POST",
      body: {
        agentId: input.agentId,
        executable: input.executable,
        args: input.args,
        workingDirectory: input.workingDirectory,
      },
      timeoutMs: 75_000,
    });
  }

  listComputerUseTools(input: RemoteDeviceCommandTargetInput): Promise<RemoteDeviceComputerUseTool[]> {
    const path = `${DEVICE_COMMAND_ROUTES.computerUseTools}?agentId=${encodeURIComponent(input.agentId)}`;
    return this.#request(input.serverId, path, decodeComputerUseTools).then(({ tools }) => tools);
  }

  callComputerUse(
    input: RemoteDeviceComputerUseCallInput & { serverId: string },
  ): Promise<RemoteDeviceComputerUseResult> {
    return this.#request(input.serverId, DEVICE_COMMAND_ROUTES.computerUseCall, decodeComputerUseResult, {
      method: "POST",
      body: { agentId: input.agentId, tool: input.tool, arguments: input.arguments },
      timeoutMs: 75_000,
    });
  }

  #request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: { method?: string; body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    if (!this.#servers.supportsCapability(serverId, DEVICE_COMMANDS_CAPABILITY)) {
      return Promise.reject(new Error("This server does not support remote device commands."));
    }
    return runCauseEffect(this.#servers.request(serverId, path, decoder, init));
  }
}
