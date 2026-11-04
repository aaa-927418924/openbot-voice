import type {
  RemoteDeviceCommandAgentTarget,
  RemoteDeviceCommandInput,
  RemoteDeviceCommandPolicy,
  RemoteDeviceCommandResult,
  RemoteDeviceCommandTarget,
  RemoteDeviceCommandTargetInput,
  RemoteDeviceComputerUseCallInput,
  RemoteDeviceComputerUseContentItem,
  RemoteDeviceComputerUseResult,
  RemoteDeviceComputerUseTool,
  RemoteDeviceShareSettings,
  ServerConnectionState,
  SetRemoteDeviceShareSettingsInput,
  UpdateRemoteDeviceCommandTargetInput,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  DEVICE_COMMANDS_V2_CAPABILITY,
  DEVICE_COMMANDS_V2_ROUTES,
} from "@openbot/contracts/team-protocol/device-commands-v2";
import { runCauseEffect } from "../backend/effect-boundary";
import type { DeviceCommandTargetServiceV2 } from "./remote-device-command-host";
import type { ResponseDecoder } from "./remote-host-decoding";
import type { RemoteServerManager } from "./remote-server-manager";

type RemoteRequestOptions = Pick<RemoteServerManager, "listDeviceCommandServers" | "request" | "supportsCapability">;

interface DeviceCommandTargetInfo {
  serverId: string;
  name: string;
  platform: "windows" | "linux";
  computerUseAvailable: boolean;
  autoReviewAvailable: boolean;
}

export interface LocalDeviceCommandTargetOptions {
  service: Pick<DeviceCommandTargetServiceV2, "infoV2" | "getPolicy" | "updatePolicy">;
  getState: () => ServerConnectionState;
}

export interface RemoteDeviceShareSettingsOptions {
  get: () => RemoteDeviceShareSettings;
  set: (input: SetRemoteDeviceShareSettingsInput) => Promise<RemoteDeviceShareSettings>;
}

function decodeTargetInfo(value: unknown): DeviceCommandTargetInfo {
  if (
    !isDynamicRecord(value) ||
    !identifier(value.serverId) ||
    !isString(value.name) ||
    value.name.length > 128 ||
    (value.platform !== "windows" && value.platform !== "linux") ||
    typeof value.computerUseAvailable !== "boolean" ||
    typeof value.autoReviewAvailable !== "boolean"
  ) {
    throw new Error("Invalid remote device information.");
  }
  return {
    serverId: value.serverId,
    name: value.name,
    platform: value.platform,
    computerUseAvailable: value.computerUseAvailable,
    autoReviewAvailable: value.autoReviewAvailable,
  };
}

function decodePolicy(value: unknown): RemoteDeviceCommandPolicy {
  if (
    !isDynamicRecord(value) ||
    typeof value.commandsEnabled !== "boolean" ||
    typeof value.computerUseEnabled !== "boolean" ||
    !(value.updatedAt === null || isString(value.updatedAt))
  ) {
    throw new Error("Invalid remote device policy response.");
  }
  return {
    commandsEnabled: value.commandsEnabled,
    computerUseEnabled: value.computerUseEnabled,
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

/** Routes owner-controlled device policies and agent operations to registered Windows/Linux hosts. */
export class RemoteDeviceCommandClient {
  readonly #servers: RemoteRequestOptions;
  readonly #localTarget: LocalDeviceCommandTargetOptions | null;
  readonly #shareSettings: RemoteDeviceShareSettingsOptions | null;

  constructor(
    servers: RemoteRequestOptions,
    localTarget: LocalDeviceCommandTargetOptions | null = null,
    shareSettings: RemoteDeviceShareSettingsOptions | null = null,
  ) {
    this.#servers = servers;
    this.#localTarget = localTarget;
    this.#shareSettings = shareSettings;
  }

  async listTargets(): Promise<RemoteDeviceCommandTarget[]> {
    const localTarget = await this.#localTargetInfo();
    const result: RemoteDeviceCommandTarget[] = localTarget ? [localTarget] : [];
    result.push(...(await this.#listRemoteTargets()));
    return result;
  }

  async #listRemoteTargets(): Promise<RemoteDeviceCommandTarget[]> {
    const result: RemoteDeviceCommandTarget[] = [];
    for (const server of this.#servers.listDeviceCommandServers()) {
      if (server.state !== "online" || !this.#servers.supportsCapability(server.id, DEVICE_COMMANDS_V2_CAPABILITY)) {
        continue;
      }
      try {
        const info = await this.#request(server.id, DEVICE_COMMANDS_V2_ROUTES.info, decodeTargetInfo);
        result.push({ ...info, state: server.state, isLocal: false });
      } catch {
        // A server can disconnect between the summary and this request. Keep the rest of the list usable.
      }
    }
    return result;
  }

  async listTargetsForAgent(agentId: string): Promise<RemoteDeviceCommandAgentTarget[]> {
    void agentId;
    const result: RemoteDeviceCommandAgentTarget[] = [];
    for (const target of await this.#listRemoteTargets()) {
      try {
        const policy = await this.#getRemotePolicy({ serverId: target.serverId });
        result.push({
          serverId: target.serverId,
          name: target.name,
          platform: target.platform,
          state: target.state,
          computerUseAvailable: target.computerUseAvailable,
          autoReviewAvailable: target.autoReviewAvailable,
          policy,
        });
      } catch {
        // The caller still sees targets whose policy can be read. No denied grant is inferred as enabled.
      }
    }
    return result;
  }

  async getPermission(input: RemoteDeviceCommandTargetInput): Promise<RemoteDeviceCommandPolicy> {
    const localTarget = this.#localTarget;
    if (localTarget && (await this.#isLocalTarget(input.serverId))) {
      return runCauseEffect(localTarget.service.getPolicy());
    }
    return this.#getRemotePolicy(input);
  }

  async updatePermission(input: UpdateRemoteDeviceCommandTargetInput): Promise<RemoteDeviceCommandPolicy> {
    const localTarget = this.#localTarget;
    if (localTarget && (await this.#isLocalTarget(input.serverId))) {
      return runCauseEffect(localTarget.service.updatePolicy(input.policy));
    }
    return this.#request(input.serverId, DEVICE_COMMANDS_V2_ROUTES.updatePolicy, decodePolicy, {
      method: "POST",
      body: input.policy,
    });
  }

  getShareSettings(): RemoteDeviceShareSettings {
    return this.#shareSettings?.get() ?? { supported: false, enabled: false };
  }

  setShareSettings(input: SetRemoteDeviceShareSettingsInput): Promise<RemoteDeviceShareSettings> {
    if (!this.#shareSettings) return Promise.resolve({ supported: false, enabled: false });
    return this.#shareSettings.set(input);
  }

  async #localTargetInfo(): Promise<RemoteDeviceCommandTarget | null> {
    if (!this.#localTarget) return null;
    try {
      const info = await runCauseEffect(this.#localTarget.service.infoV2());
      return { ...info, state: this.#localTarget.getState(), isLocal: true };
    } catch {
      // A local identity is not guaranteed before the user creates a local server.
      return null;
    }
  }

  async #isLocalTarget(serverId: string): Promise<boolean> {
    return (await this.#localTargetInfo())?.serverId === serverId;
  }

  #getRemotePolicy(input: RemoteDeviceCommandTargetInput): Promise<RemoteDeviceCommandPolicy> {
    return this.#request(input.serverId, DEVICE_COMMANDS_V2_ROUTES.policy, decodePolicy);
  }

  run(input: RemoteDeviceCommandInput & { serverId: string }): Promise<RemoteDeviceCommandResult> {
    return this.#request(input.serverId, DEVICE_COMMANDS_V2_ROUTES.run, decodeCommandResult, {
      method: "POST",
      body: {
        agentId: input.agentId,
        executable: input.executable,
        args: input.args,
        workingDirectory: input.workingDirectory,
      },
      timeoutMs: 180_000,
    });
  }

  listComputerUseTools(input: RemoteDeviceCommandTargetInput): Promise<RemoteDeviceComputerUseTool[]> {
    void input;
    return this.#request(input.serverId, DEVICE_COMMANDS_V2_ROUTES.computerUseTools, decodeComputerUseTools).then(
      ({ tools }) => tools,
    );
  }

  callComputerUse(
    input: RemoteDeviceComputerUseCallInput & { serverId: string },
  ): Promise<RemoteDeviceComputerUseResult> {
    return this.#request(input.serverId, DEVICE_COMMANDS_V2_ROUTES.computerUseCall, decodeComputerUseResult, {
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
    if (!this.#servers.supportsCapability(serverId, DEVICE_COMMANDS_V2_CAPABILITY)) {
      return Promise.reject(new Error("This server does not support remote device commands."));
    }
    return runCauseEffect(this.#servers.request(serverId, path, decoder, init));
  }
}
