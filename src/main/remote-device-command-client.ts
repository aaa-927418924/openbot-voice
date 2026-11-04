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
import {
  remoteDeviceDiagnosticsLogger as logger,
  RemoteDeviceDiagnosticError,
  remoteDeviceFailureDetails,
  remoteDeviceOperationId,
  remoteDeviceTag,
} from "./remote-device-diagnostics";
import type { ResponseDecoder } from "./remote-host-decoding";
import type { RemoteServerManager } from "./remote-server-manager";

type RemoteRequestOptions = Pick<
  RemoteServerManager,
  "listDeviceCommandServers" | "request" | "supportsCapability" | "ensureCapability"
>;

interface DeviceCommandTargetInfo {
  serverId: string;
  name: string;
  deviceName: string | null;
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
  const deviceName = isDynamicRecord(value) ? value.deviceName : undefined;
  if (
    !isDynamicRecord(value) ||
    !identifier(value.serverId) ||
    !isString(value.name) ||
    value.name.length > 128 ||
    (value.platform !== "windows" && value.platform !== "linux") ||
    (deviceName !== undefined && (!isString(deviceName) || deviceName.length === 0 || deviceName.length > 128)) ||
    typeof value.computerUseAvailable !== "boolean" ||
    typeof value.autoReviewAvailable !== "boolean"
  ) {
    throw new RemoteDeviceDiagnosticError("invalid_target_info");
  }
  return {
    serverId: value.serverId,
    name: value.name,
    deviceName: isString(deviceName) ? deviceName : null,
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
    throw new RemoteDeviceDiagnosticError("invalid_policy_response");
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
    const operationId = remoteDeviceOperationId();
    const localTarget = await this.#localTargetInfo();
    logger.info("Remote device settings target list completed.", {
      operationId,
      localTargetAvailable: localTarget !== null,
    });
    return localTarget ? [localTarget] : [];
  }

  async #listRemoteTargets(operationId: string, caller: "agent"): Promise<RemoteDeviceCommandTarget[]> {
    const result: RemoteDeviceCommandTarget[] = [];
    const servers = this.#servers.listDeviceCommandServers();
    const connectionStates = { online: 0, connecting: 0, offline: 0, error: 0, incompatible: 0 };
    for (const server of servers) connectionStates[server.state] += 1;
    logger.info("Remote device target scan started.", {
      operationId,
      caller,
      candidateCount: servers.length,
      connectionStates,
      candidates: servers.map((server) => ({
        serverTag: remoteDeviceTag(server.id),
        state: server.state,
        deviceOnly: server.deviceOnly,
        transport: server.transport,
        endpointTag: server.endpointTag,
      })),
    });
    for (const server of servers) {
      const serverTag = remoteDeviceTag(server.id);
      try {
        const info = await this.#request(
          server.id,
          DEVICE_COMMANDS_V2_ROUTES.info,
          decodeTargetInfo,
          undefined,
          operationId,
        );
        // Device commands use the authenticated HTTP API. A stale/offline event socket must not
        // hide a target whose device-operation endpoint just responded successfully.
        result.push({
          serverId: info.serverId,
          name: agentDeviceName(info.deviceName, info.platform, info.serverId),
          platform: info.platform,
          computerUseAvailable: info.computerUseAvailable,
          autoReviewAvailable: info.autoReviewAvailable,
          state: "online",
          isLocal: false,
        });
        logger.info("Remote device target discovered.", {
          operationId,
          serverTag,
          platform: info.platform,
          deviceNameAvailable: info.deviceName !== null,
          computerUseAvailable: info.computerUseAvailable,
          autoReviewAvailable: info.autoReviewAvailable,
        });
      } catch (error) {
        // A host can be unsupported or unreachable. Keep the rest of the list usable.
        logger.warn("Remote device target was omitted.", {
          operationId,
          serverTag,
          ...remoteDeviceFailureDetails(error),
        });
      }
    }
    logger.info("Remote device target scan completed.", {
      operationId,
      candidateCount: servers.length,
      discoveredCount: result.length,
    });
    return result;
  }

  async listTargetsForAgent(agentId: string, requestedOperationId?: string): Promise<RemoteDeviceCommandAgentTarget[]> {
    void agentId;
    const operationId = requestedOperationId ?? remoteDeviceOperationId();
    const result: RemoteDeviceCommandAgentTarget[] = [];
    let policyUnavailableCount = 0;
    for (const target of await this.#listRemoteTargets(operationId, "agent")) {
      let policy: RemoteDeviceCommandPolicy | null = null;
      try {
        policy = await this.#getRemotePolicy({ serverId: target.serverId }, operationId);
      } catch {
        // Keep a reachable device visible. A null policy does not claim that any permission is enabled.
        policyUnavailableCount += 1;
      }
      result.push({
        serverId: target.serverId,
        name: target.name,
        platform: target.platform,
        state: target.state,
        computerUseAvailable: target.computerUseAvailable,
        autoReviewAvailable: target.autoReviewAvailable,
        policy,
      });
    }
    const windowsCount = result.filter((target) => target.platform === "windows").length;
    const linuxCount = result.filter((target) => target.platform === "linux").length;
    logger.info("Agent remote device list completed.", {
      operationId,
      targetCount: result.length,
      windowsCount,
      linuxCount,
      policyUnavailableCount,
    });
    return result;
  }

  async getPermission(input: RemoteDeviceCommandTargetInput): Promise<RemoteDeviceCommandPolicy> {
    const localTarget = this.#localTarget;
    if (!localTarget || !(await this.#isLocalTarget(input.serverId))) {
      throw new Error("Only this computer's permissions can be read here.");
    }
    return runCauseEffect(localTarget.service.getPolicy());
  }

  async updatePermission(input: UpdateRemoteDeviceCommandTargetInput): Promise<RemoteDeviceCommandPolicy> {
    const localTarget = this.#localTarget;
    if (!localTarget || !(await this.#isLocalTarget(input.serverId))) {
      throw new Error("Only this computer's permissions can be changed here.");
    }
    return runCauseEffect(localTarget.service.updatePolicy(input.policy));
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

  #getRemotePolicy(input: RemoteDeviceCommandTargetInput, operationId?: string): Promise<RemoteDeviceCommandPolicy> {
    return this.#request(input.serverId, DEVICE_COMMANDS_V2_ROUTES.policy, decodePolicy, undefined, operationId);
  }

  run(
    input: RemoteDeviceCommandInput & { serverId: string },
    operationId = remoteDeviceOperationId(),
  ): Promise<RemoteDeviceCommandResult> {
    return this.#request(
      input.serverId,
      DEVICE_COMMANDS_V2_ROUTES.run,
      decodeCommandResult,
      {
        method: "POST",
        body: {
          agentId: input.agentId,
          executable: input.executable,
          args: input.args,
          workingDirectory: input.workingDirectory,
        },
        timeoutMs: 180_000,
      },
      operationId,
    );
  }

  listComputerUseTools(
    input: RemoteDeviceCommandTargetInput,
    operationId = remoteDeviceOperationId(),
  ): Promise<RemoteDeviceComputerUseTool[]> {
    void input;
    return this.#request(
      input.serverId,
      DEVICE_COMMANDS_V2_ROUTES.computerUseTools,
      decodeComputerUseTools,
      undefined,
      operationId,
    ).then(({ tools }) => tools);
  }

  callComputerUse(
    input: RemoteDeviceComputerUseCallInput & { serverId: string },
    operationId = remoteDeviceOperationId(),
  ): Promise<RemoteDeviceComputerUseResult> {
    return this.#request(
      input.serverId,
      DEVICE_COMMANDS_V2_ROUTES.computerUseCall,
      decodeComputerUseResult,
      {
        method: "POST",
        body: { agentId: input.agentId, tool: input.tool, arguments: input.arguments },
        timeoutMs: 75_000,
      },
      operationId,
    );
  }

  async #request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: { method?: string; body?: unknown; timeoutMs?: number; diagnosticOperationId?: string },
    operationId = remoteDeviceOperationId(),
  ): Promise<T> {
    const serverTag = remoteDeviceTag(serverId);
    const candidate = this.#servers.listDeviceCommandServers().find((server) => server.id === serverId);
    const route = deviceCommandRouteLabel(path);
    const method = init?.method ?? "GET";
    const capabilityCached = this.#servers.supportsCapability(serverId, DEVICE_COMMANDS_V2_CAPABILITY);
    let stage = "capability_check";
    logger.info("Remote device API request started.", {
      operationId,
      serverTag,
      route,
      method,
      capabilityCached,
      ...(candidate
        ? {
            state: candidate.state,
            deviceOnly: candidate.deviceOnly,
            transport: candidate.transport,
            endpointTag: candidate.endpointTag,
          }
        : {}),
    });
    const startedAt = Date.now();
    try {
      if (!capabilityCached) {
        stage = "capability_refresh";
        const supported = await runCauseEffect(this.#servers.ensureCapability(serverId, DEVICE_COMMANDS_V2_CAPABILITY));
        if (!supported) {
          logger.warn("Remote device capability is unavailable.", {
            operationId,
            serverTag,
            route,
            stage,
            durationMs: Date.now() - startedAt,
          });
          throw new RemoteDeviceDiagnosticError(
            "capability_unavailable",
            "This server does not support remote device commands.",
          );
        }
      }
      stage = "http_request";
      const response = await runCauseEffect(
        this.#servers.request(serverId, path, decoder, { ...init, diagnosticOperationId: operationId }),
      );
      logger.info("Remote device API request completed.", {
        operationId,
        serverTag,
        route,
        stage,
        httpStatus: 200,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      logger.warn("Remote device API request failed.", {
        operationId,
        serverTag,
        route,
        stage,
        durationMs: Date.now() - startedAt,
        ...remoteDeviceFailureDetails(error),
      });
      throw error;
    }
  }
}

function deviceCommandRouteLabel(path: string) {
  if (path === DEVICE_COMMANDS_V2_ROUTES.info) return "target_info";
  if (path === DEVICE_COMMANDS_V2_ROUTES.policy) return "policy";
  if (path === DEVICE_COMMANDS_V2_ROUTES.updatePolicy) return "update_policy";
  if (path === DEVICE_COMMANDS_V2_ROUTES.run) return "run";
  if (path === DEVICE_COMMANDS_V2_ROUTES.computerUseTools) return "computer_use_tools";
  if (path === DEVICE_COMMANDS_V2_ROUTES.computerUseCall) return "computer_use_call";
  return "unknown_device_command_route";
}

function agentDeviceName(
  deviceName: string | null,
  platform: DeviceCommandTargetInfo["platform"],
  serverId: string,
): string {
  const platformName = platform === "windows" ? "Windows" : "Linux";
  if (deviceName) return `${deviceName} (${platformName})`;
  return `Device name unavailable (${platformName}; ${serverId.slice(-8)})`;
}
