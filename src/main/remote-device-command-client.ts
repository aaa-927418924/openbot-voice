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
import {
  DEVICE_COMMANDS_V3_CAPABILITY,
  DEVICE_COMMANDS_V3_ROUTES,
} from "@openbot/contracts/team-protocol/device-commands-v3";
import {
  DEVICE_COMMANDS_V4_CAPABILITY,
  DEVICE_COMMANDS_V4_ROUTES,
} from "@openbot/contracts/team-protocol/device-commands-v4";
import { runCauseEffect } from "../backend/effect-boundary";
import type { RemoteDeviceCommandDecisionReviewer } from "./remote-device-command-decision-reviewer";
import type { DeviceCommandTargetServiceV3 } from "./remote-device-command-host";
import { planRemoteCommandReview } from "./remote-device-command-local-review";
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
  localReviewAvailable: boolean;
}

export interface LocalDeviceCommandTargetOptions {
  service: Pick<DeviceCommandTargetServiceV3, "infoV3" | "getPolicy" | "updatePolicy">;
  getState: () => ServerConnectionState;
}

export interface RemoteDeviceShareSettingsOptions {
  get: () => RemoteDeviceShareSettings;
  set: (input: SetRemoteDeviceShareSettingsInput) => Promise<RemoteDeviceShareSettings>;
}

export interface RemoteDeviceCommandClientOptions {
  /** Remote device command and Computer Use tools are offered only by OpenBot Cloud hosts. */
  cloudHostMode?: boolean;
  /** Runs only on the Cloud Linux host; command content is reviewed before leaving it. */
  localDecisionReviewer?: Pick<RemoteDeviceCommandDecisionReviewer, "review">;
  /** Refreshes an account-backed host session after its cached Team API token receives HTTP 401. */
  refreshAccountSession?: (serverId: string) => Promise<unknown>;
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
    typeof value.localReviewAvailable !== "boolean"
  ) {
    throw new RemoteDeviceDiagnosticError("invalid_target_info");
  }
  return {
    serverId: value.serverId,
    name: value.name,
    deviceName: isString(deviceName) ? deviceName : null,
    platform: value.platform,
    computerUseAvailable: value.computerUseAvailable,
    localReviewAvailable: value.localReviewAvailable,
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
  readonly #cloudHostMode: boolean;
  readonly #localDecisionReviewer: RemoteDeviceCommandClientOptions["localDecisionReviewer"] | null;
  readonly #refreshAccountSession: RemoteDeviceCommandClientOptions["refreshAccountSession"] | null;

  constructor(
    servers: RemoteRequestOptions,
    localTarget: LocalDeviceCommandTargetOptions | null = null,
    shareSettings: RemoteDeviceShareSettingsOptions | null = null,
    options: RemoteDeviceCommandClientOptions = {},
  ) {
    this.#servers = servers;
    this.#localTarget = localTarget;
    this.#shareSettings = shareSettings;
    this.#cloudHostMode = options.cloudHostMode === true;
    this.#localDecisionReviewer = options.localDecisionReviewer ?? null;
    this.#refreshAccountSession = options.refreshAccountSession ?? null;
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
    const allServers = this.#servers.listDeviceCommandServers();
    const servers = allServers.filter((server) => server.deviceOnly === true);
    const connectionStates = { online: 0, connecting: 0, offline: 0, error: 0, incompatible: 0 };
    for (const server of servers) connectionStates[server.state] += 1;
    logger.info("Remote device target scan started.", {
      operationId,
      caller,
      candidateCount: servers.length,
      excludedLocalServerCount: allServers.length - servers.length,
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
          DEVICE_COMMANDS_V3_ROUTES.info,
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
          localReviewAvailable: info.localReviewAvailable,
          state: "online",
          isLocal: false,
        });
        logger.info("Remote device target discovered.", {
          operationId,
          serverTag,
          platform: info.platform,
          deviceNameAvailable: info.deviceName !== null,
          computerUseAvailable: info.computerUseAvailable,
          localReviewAvailable: info.localReviewAvailable,
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
    if (!this.#cloudHostMode) {
      logger.info("Remote device targets were omitted outside OpenBot Cloud host mode.", { operationId });
      return [];
    }
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
        localReviewAvailable: target.localReviewAvailable,
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
      const info = await runCauseEffect(this.#localTarget.service.infoV3());
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

  async run(
    input: RemoteDeviceCommandInput & { serverId: string },
    operationId = remoteDeviceOperationId(),
  ): Promise<RemoteDeviceCommandResult> {
    if (!this.#cloudHostMode)
      throw new Error("Remote device operations are available only from an OpenBot Cloud host.");
    this.#requireDeviceOnlyTarget(input.serverId);
    const policy = await this.#getRemotePolicy({ serverId: input.serverId }, operationId);
    if (!policy.commandsEnabled) throw new Error("Remote command execution is not enabled on this device.");
    const target = await this.#request(
      input.serverId,
      DEVICE_COMMANDS_V3_ROUTES.info,
      decodeTargetInfo,
      undefined,
      operationId,
    );
    const targetRuntimePlatform = target.platform === "windows" ? "win32" : "linux";
    const review = planRemoteCommandReview(input.executable, input.args, targetRuntimePlatform);
    if (review.decision === "block") {
      logger.info("Cloud blocked a catastrophic remote command before contacting the target.", {
        operationId,
        serverTag: remoteDeviceTag(input.serverId),
        platform: target.platform,
        rule: review.reason,
      });
      throw new Error("The remote command was blocked by a catastrophic-operation rule.");
    }
    if (review.decision === "model_review") {
      if (!this.#localDecisionReviewer) {
        logger.warn("Cloud could not run its local d1 review; the remote command was denied.", {
          operationId,
          serverTag: remoteDeviceTag(input.serverId),
          platform: process.platform,
        });
        throw new Error("The Cloud local safety model is unavailable; the remote command was denied.");
      }
      const decision = await this.#localDecisionReviewer.review(
        input.executable,
        input.args,
        input.workingDirectory,
        target.platform,
      );
      if (decision !== "allow") {
        logger.info("Cloud denied a remote command in its local d1 review.", {
          operationId,
          serverTag: remoteDeviceTag(input.serverId),
          platform: process.platform,
          decision,
        });
        throw new Error("The remote command was denied by the Cloud local safety review.");
      }
    }
    return this.#request(
      input.serverId,
      DEVICE_COMMANDS_V4_ROUTES.run,
      decodeCommandResult,
      {
        method: "POST",
        body: {
          agentId: input.agentId,
          executable: input.executable,
          args: input.args,
          workingDirectory: input.workingDirectory,
          safetyReviewed: true,
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
    if (!this.#cloudHostMode)
      throw new Error("Remote device operations are available only from an OpenBot Cloud host.");
    this.#requireDeviceOnlyTarget(input.serverId);
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
    if (!this.#cloudHostMode)
      throw new Error("Remote device operations are available only from an OpenBot Cloud host.");
    this.#requireDeviceOnlyTarget(input.serverId);
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

  #requireDeviceOnlyTarget(serverId: string): void {
    const candidate = this.#servers.listDeviceCommandServers().find((server) => server.id === serverId);
    if (candidate?.deviceOnly !== true) {
      logger.warn("Cloud rejected a remote operation target that is not a shared device-only host.", {
        serverTag: remoteDeviceTag(serverId),
        targetFound: candidate !== undefined,
        deviceOnly: candidate?.deviceOnly ?? false,
      });
      throw new Error(
        "Only a device shared for remote operations can be targeted; regular OpenBot servers are excluded.",
      );
    }
  }

  async #request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: { method?: string; body?: unknown; timeoutMs?: number; diagnosticOperationId?: string },
    operationId = remoteDeviceOperationId(),
    retryAfterAuthRefresh = true,
  ): Promise<T> {
    const serverTag = remoteDeviceTag(serverId);
    const candidate = this.#servers.listDeviceCommandServers().find((server) => server.id === serverId);
    const route = deviceCommandRouteLabel(path);
    const method = init?.method ?? "GET";
    const capability = path.startsWith("/v4/device-commands/")
      ? DEVICE_COMMANDS_V4_CAPABILITY
      : path.startsWith("/v3/device-commands/")
        ? DEVICE_COMMANDS_V3_CAPABILITY
        : DEVICE_COMMANDS_V2_CAPABILITY;
    const capabilityCached = this.#servers.supportsCapability(serverId, capability);
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
        const supported = await runCauseEffect(this.#servers.ensureCapability(serverId, capability));
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
      const failure = remoteDeviceFailureDetails(error);
      if (failure.httpStatus === 401 && retryAfterAuthRefresh && this.#refreshAccountSession) {
        logger.info("Remote device API rejected its cached account session; refreshing it once.", {
          operationId,
          serverTag,
          route,
        });
        try {
          await this.#refreshAccountSession(serverId);
        } catch (refreshError) {
          logger.warn("Remote device account session refresh failed.", {
            operationId,
            serverTag,
            route,
            ...remoteDeviceFailureDetails(refreshError),
          });
          throw refreshError;
        }
        logger.info("Remote device account session refreshed; retrying the request once.", {
          operationId,
          serverTag,
          route,
        });
        return this.#request(serverId, path, decoder, init, operationId, false);
      }
      logger.warn("Remote device API request failed.", {
        operationId,
        serverTag,
        route,
        stage,
        durationMs: Date.now() - startedAt,
        ...failure,
      });
      throw error;
    }
  }
}

function deviceCommandRouteLabel(path: string) {
  if (path === DEVICE_COMMANDS_V4_ROUTES.run) return "run_after_cloud_review";
  if (path === DEVICE_COMMANDS_V3_ROUTES.info) return "target_info_hard_deny";
  if (path === DEVICE_COMMANDS_V3_ROUTES.run) return "run_after_cloud_review";
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
