import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  RemoteDeviceCommandInput,
  RemoteDeviceCommandPermission,
  RemoteDeviceCommandPolicy,
  RemoteDeviceCommandResult,
  RemoteDeviceComputerUseCallInput,
  RemoteDeviceComputerUseContentItem,
  RemoteDeviceComputerUseResult,
  RemoteDeviceComputerUseTool,
  UpdateRemoteDeviceCommandPermissionInput,
  UpdateRemoteDeviceCommandPolicyInput,
} from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect, Result, Schema, Semaphore } from "effect";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";
import { isMissingFileError } from "../backend/file-errors";
import type { CuaDriverRuntime } from "./cua-driver-runtime";
import { readPreferenceFile } from "./preference-file";
import type { CodexAutoReview } from "./remote-device-codex-review";
import { CodexAutoReviewDenied, CodexAutoReviewUnavailable } from "./remote-device-codex-review";
import { remoteCommandRequiresAutoReview } from "./remote-device-command-risk";
import { remoteDeviceDiagnosticsLogger as logger, remoteDeviceTag } from "./remote-device-diagnostics";

const MAX_COMMAND_RUNTIME_MS = 45_000;
const MAX_COMMAND_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 4_096;
const MAX_CAPTURED_OUTPUT = 30_000;
const MAX_CUA_REQUEST_MS = 30_000;
const MAX_CUA_TEXT = 65_536;
const MAX_CUA_IMAGE_URL = 5_600_000;
const POLICY_VERSION = 2;
const EMBEDDED_DRIVER_ENV = "CUA_DRIVER_EMBEDDED";

type FailureReason =
  | "unsupported"
  | "permission"
  | "review"
  | "auto_review"
  | "invalid"
  | "unavailable"
  | "storage"
  | "execution";

export class RemoteDeviceCommandHostError extends Schema.TaggedError<RemoteDeviceCommandHostError>()(
  "RemoteDeviceCommandHostError",
  {
    reason: Schema.Literals([
      "unsupported",
      "permission",
      "review",
      "auto_review",
      "invalid",
      "unavailable",
      "storage",
      "execution",
    ]),
    cause: Schema.Defect(),
  },
) {
  constructor(reason: FailureReason, cause?: unknown) {
    super({ reason, cause: cause ?? new Error(reason) });
  }
}

type DeviceCommandComputerUseInput = Omit<RemoteDeviceComputerUseCallInput, "serverId">;

interface StoredExecutable {
  name: string;
  path: string;
}
interface StoredPermission extends Omit<RemoteDeviceCommandPermission, "updatedAt" | "allowedExecutables"> {
  allowedExecutables: StoredExecutable[];
  updatedAt: string;
}
interface DeviceCommandPolicyFile {
  version: typeof POLICY_VERSION;
  agents: Record<string, StoredPermission>;
}

interface DeviceWidePolicyFile {
  version: 1;
  commandsEnabled: boolean;
  computerUseEnabled: boolean;
  updatedAt: string;
}

export interface RemoteDeviceCommandHostOptions {
  /** A private file in this OpenBot profile. It stores grants on the target computer. */
  userDataPath: string;
  getServerId: () => string | null;
  getServerName: () => string;
  cuaDriver: Pick<CuaDriverRuntime, "mcpServerForProviders">;
  platform?: NodeJS.Platform;
  autoReview?: Pick<CodexAutoReview, "available" | "run">;
}

export interface DeviceCommandTargetService {
  info: () => Effect.Effect<
    { serverId: string; name: string; platform: "windows" | "linux"; computerUseAvailable: boolean },
    RemoteDeviceCommandHostError
  >;
  getPermission: (agentId: string) => Effect.Effect<RemoteDeviceCommandPermission, RemoteDeviceCommandHostError>;
  updatePermission: (
    input: UpdateRemoteDeviceCommandPermissionInput,
  ) => Effect.Effect<RemoteDeviceCommandPermission, RemoteDeviceCommandHostError>;
  run: (input: RemoteDeviceCommandInput) => Effect.Effect<RemoteDeviceCommandResult, RemoteDeviceCommandHostError>;
  listComputerUseTools: (agentId: string) => Effect.Effect<RemoteDeviceComputerUseTool[], RemoteDeviceCommandHostError>;
  callComputerUse: (
    input: DeviceCommandComputerUseInput,
  ) => Effect.Effect<RemoteDeviceComputerUseResult, RemoteDeviceCommandHostError>;
}

export interface DeviceCommandTargetServiceV2 {
  /** Returns a pseudonymous local log tag. It is never included in Team API responses. */
  diagnosticTag?: () => string | null;
  infoV2: () => Effect.Effect<
    {
      serverId: string;
      name: string;
      deviceName: string;
      platform: "windows" | "linux";
      computerUseAvailable: boolean;
      autoReviewAvailable: boolean;
    },
    RemoteDeviceCommandHostError
  >;
  getPolicy: () => Effect.Effect<RemoteDeviceCommandPolicy, RemoteDeviceCommandHostError>;
  updatePolicy: (
    input: UpdateRemoteDeviceCommandPolicyInput,
  ) => Effect.Effect<RemoteDeviceCommandPolicy, RemoteDeviceCommandHostError>;
  runWithAutoReview: (
    input: RemoteDeviceCommandInput,
  ) => Effect.Effect<RemoteDeviceCommandResult, RemoteDeviceCommandHostError>;
  listComputerUseToolsDeviceWide: () => Effect.Effect<RemoteDeviceComputerUseTool[], RemoteDeviceCommandHostError>;
  callComputerUseDeviceWide: (
    input: DeviceCommandComputerUseInput,
  ) => Effect.Effect<RemoteDeviceComputerUseResult, RemoteDeviceCommandHostError>;
}

/**
 * Owns the target computer's command grants and process launches.
 *
 * The executable list, working-directory list, and risk checks are application controls. They are
 * not an operating-system sandbox. Commands run as the OpenBot user and may still affect other
 * files that this user can reach. Computer Use reuses the CUA driver's separate agent cursor and
 * background actions; it does not move the user's system cursor.
 */
export class RemoteDeviceCommandHost implements DeviceCommandTargetService, DeviceCommandTargetServiceV2 {
  readonly #path: string;
  readonly #getServerId: RemoteDeviceCommandHostOptions["getServerId"];
  readonly #getServerName: RemoteDeviceCommandHostOptions["getServerName"];
  readonly #cuaDriver: RemoteDeviceCommandHostOptions["cuaDriver"];
  readonly #platform: NodeJS.Platform;
  readonly #autoReview: RemoteDeviceCommandHostOptions["autoReview"] | null;
  readonly #devicePolicyPath: string;
  readonly #writes = Semaphore.makeUnsafe(1);

  constructor(options: RemoteDeviceCommandHostOptions) {
    this.#path = join(options.userDataPath, "openbot-device-command-policy-v2.json");
    this.#devicePolicyPath = join(options.userDataPath, "openbot-device-command-policy-v3.json");
    this.#getServerId = options.getServerId;
    this.#getServerName = options.getServerName;
    this.#cuaDriver = options.cuaDriver;
    this.#platform = options.platform ?? process.platform;
    this.#autoReview = options.autoReview ?? null;
  }

  diagnosticTag(): string | null {
    const serverId = this.#getServerId();
    return serverId ? remoteDeviceTag(serverId) : null;
  }

  readonly infoV2 = Effect.fn("RemoteDeviceCommandHost.infoV2")(function* (
    this: RemoteDeviceCommandHost,
  ): Effect.fn.Return<
    {
      serverId: string;
      name: string;
      deviceName: string;
      platform: "windows" | "linux";
      computerUseAvailable: boolean;
      autoReviewAvailable: boolean;
    },
    RemoteDeviceCommandHostError
  > {
    const info = yield* this.info();
    const autoReviewAvailable = yield* Effect.tryPromise({
      try: () => this.#autoReview?.available() ?? Promise.resolve(false),
      catch: () => new RemoteDeviceCommandHostError("unavailable"),
    });
    const deviceName = hostname().trim().slice(0, 128);
    logger.info("Remote device host information was served.", {
      serverTag: remoteDeviceTag(info.serverId),
      platform: info.platform,
      deviceNameAvailable: deviceName.length > 0,
      computerUseAvailable: info.computerUseAvailable,
      autoReviewAvailable,
    });
    return { ...info, deviceName, autoReviewAvailable };
  });

  readonly getPolicy = Effect.fn("RemoteDeviceCommandHost.getPolicy")(function* (
    this: RemoteDeviceCommandHost,
  ): Effect.fn.Return<RemoteDeviceCommandPolicy, RemoteDeviceCommandHostError> {
    const policy = yield* this.#readDevicePolicy();
    return {
      commandsEnabled: policy.commandsEnabled,
      computerUseEnabled: policy.computerUseEnabled,
      updatedAt: policy.updatedAt || null,
    };
  });

  readonly updatePolicy = Effect.fn("RemoteDeviceCommandHost.updatePolicy")(function* (
    this: RemoteDeviceCommandHost,
    input: UpdateRemoteDeviceCommandPolicyInput,
  ): Effect.fn.Return<RemoteDeviceCommandPolicy, RemoteDeviceCommandHostError> {
    if (
      (this.#platform !== "win32" && this.#platform !== "linux") ||
      !isBoolean(input.commandsEnabled) ||
      !isBoolean(input.computerUseEnabled)
    ) {
      return yield* new RemoteDeviceCommandHostError("invalid");
    }
    const stored = yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const next: DeviceWidePolicyFile = {
          version: 1,
          commandsEnabled: input.commandsEnabled,
          computerUseEnabled: input.computerUseEnabled,
          updatedAt: new Date().toISOString(),
        };
        yield* writeJsonFileAtomically(this.#devicePolicyPath, next, { createDirectory: true }).pipe(
          Effect.mapError((failure) => new RemoteDeviceCommandHostError("storage", failure.cause)),
        );
        return next;
      }),
    );
    return {
      commandsEnabled: stored.commandsEnabled,
      computerUseEnabled: stored.computerUseEnabled,
      updatedAt: stored.updatedAt,
    };
  });

  readonly runWithAutoReview = Effect.fn("RemoteDeviceCommandHost.runWithAutoReview")(function* (
    this: RemoteDeviceCommandHost,
    input: RemoteDeviceCommandInput,
  ): Effect.fn.Return<RemoteDeviceCommandResult, RemoteDeviceCommandHostError> {
    if (!isAgentId(input.agentId) || !validExecutableName(input.executable) || !validArgs(input.args)) {
      return yield* new RemoteDeviceCommandHostError("invalid");
    }
    if (this.#platform !== "win32" && this.#platform !== "linux") {
      return yield* new RemoteDeviceCommandHostError("unsupported");
    }
    const policy = yield* this.#readDevicePolicy();
    if (!policy.commandsEnabled) return yield* new RemoteDeviceCommandHostError("permission");
    if (!this.#autoReview) return yield* new RemoteDeviceCommandHostError("auto_review");
    const workingDirectory = yield* Effect.tryPromise({
      try: () => canonicalWorkingDirectoryUnrestricted(input.workingDirectory),
      catch: (cause) =>
        cause instanceof RemoteDeviceCommandHostError ? cause : new RemoteDeviceCommandHostError("invalid", cause),
    });
    return yield* Effect.tryPromise({
      try: () =>
        this.#autoReview?.run({ ...input, workingDirectory }) ??
        Promise.reject(new CodexAutoReviewUnavailable("resolve_cli")),
      catch: (cause) =>
        new RemoteDeviceCommandHostError(
          cause instanceof CodexAutoReviewDenied
            ? "review"
            : cause instanceof CodexAutoReviewUnavailable
              ? "auto_review"
              : "execution",
          cause,
        ),
    });
  });

  readonly listComputerUseToolsDeviceWide = Effect.fn("RemoteDeviceCommandHost.listComputerUseToolsDeviceWide")(
    function* (
      this: RemoteDeviceCommandHost,
    ): Effect.fn.Return<RemoteDeviceComputerUseTool[], RemoteDeviceCommandHostError> {
      const policy = yield* this.#readDevicePolicy();
      if (!policy.computerUseEnabled) return yield* new RemoteDeviceCommandHostError("permission");
      const config = this.#cuaDriver.mcpServerForProviders();
      if (!config) return yield* new RemoteDeviceCommandHostError("unavailable");
      return yield* Effect.tryPromise({
        try: (signal) =>
          withCuaClient(
            config,
            async (client, signal) => {
              const { tools } = await client.listTools(undefined, { signal });
              return tools.slice(0, 128).map((tool) => ({
                name: tool.name.slice(0, 128),
                description: (tool.description ?? "").slice(0, 2_048),
              }));
            },
            signal,
          ),
        catch: () => new RemoteDeviceCommandHostError("unavailable"),
      });
    },
  );

  readonly callComputerUseDeviceWide = Effect.fn("RemoteDeviceCommandHost.callComputerUseDeviceWide")(function* (
    this: RemoteDeviceCommandHost,
    input: DeviceCommandComputerUseInput,
  ): Effect.fn.Return<RemoteDeviceComputerUseResult, RemoteDeviceCommandHostError> {
    if (!isAgentId(input.agentId) || input.tool.length === 0 || input.tool.length > 128 || input.tool.includes("\0")) {
      return yield* new RemoteDeviceCommandHostError("invalid");
    }
    const policy = yield* this.#readDevicePolicy();
    if (!policy.computerUseEnabled) return yield* new RemoteDeviceCommandHostError("permission");
    const config = this.#cuaDriver.mcpServerForProviders();
    if (!config) return yield* new RemoteDeviceCommandHostError("unavailable");
    return yield* Effect.tryPromise({
      try: (signal) =>
        withCuaClient(
          config,
          async (client, signal) => {
            const { tools } = await client.listTools(undefined, { signal });
            if (!tools.some((candidate) => candidate.name === input.tool)) {
              throw new Error("Requested Computer Use tool is not available.");
            }
            const result = await client.callTool({ name: input.tool, arguments: input.arguments }, undefined, {
              signal,
            });
            if (!isCallToolResult(result)) throw new Error("Computer Use returned no tool result.");
            return { success: !result.isError, contentItems: cuaContentItems(result) };
          },
          signal,
        ),
      catch: () => new RemoteDeviceCommandHostError("unavailable"),
    });
  });

  readonly info = Effect.fn("RemoteDeviceCommandHost.info")(function* (
    this: RemoteDeviceCommandHost,
  ): Effect.fn.Return<
    { serverId: string; name: string; platform: "windows" | "linux"; computerUseAvailable: boolean },
    RemoteDeviceCommandHostError
  > {
    if (this.#platform !== "win32" && this.#platform !== "linux") {
      return yield* new RemoteDeviceCommandHostError("unsupported");
    }
    const serverId = this.#getServerId();
    if (!serverId) return yield* new RemoteDeviceCommandHostError("unavailable");
    return {
      serverId,
      name: this.#getServerName(),
      platform: this.#platform === "win32" ? "windows" : "linux",
      computerUseAvailable: this.#cuaDriver.mcpServerForProviders() !== null,
    };
  });

  readonly getPermission = Effect.fn("RemoteDeviceCommandHost.getPermission")(function* (
    this: RemoteDeviceCommandHost,
    agentId: string,
  ): Effect.fn.Return<RemoteDeviceCommandPermission, RemoteDeviceCommandHostError> {
    if (!isAgentId(agentId)) return yield* new RemoteDeviceCommandHostError("invalid");
    const file = yield* this.#readPolicy();
    return this.#permission(agentId, file.agents[agentId]);
  });

  readonly updatePermission = Effect.fn("RemoteDeviceCommandHost.updatePermission")(function* (
    this: RemoteDeviceCommandHost,
    input: UpdateRemoteDeviceCommandPermissionInput,
  ): Effect.fn.Return<RemoteDeviceCommandPermission, RemoteDeviceCommandHostError> {
    if (this.#platform !== "win32" && this.#platform !== "linux") {
      return yield* new RemoteDeviceCommandHostError("unsupported");
    }
    if (
      !isAgentId(input.agentId) ||
      input.allowedExecutables.some((value) => !validExecutableName(value.trim())) ||
      input.allowedDirectories.length > 32 ||
      input.allowedExecutables.length > 64
    ) {
      return yield* new RemoteDeviceCommandHostError("invalid");
    }
    const [canonicalExecutables, canonicalDirectories] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          resolveAllowedExecutables(input.allowedExecutables, this.#platform),
          resolveAllowedDirectories(input.allowedDirectories),
        ]),
      catch: () => new RemoteDeviceCommandHostError("invalid"),
    });
    const updatedAt = new Date().toISOString();
    const stored: StoredPermission = {
      agentId: input.agentId,
      commandsEnabled: input.commandsEnabled,
      computerUseEnabled: input.computerUseEnabled,
      allowedExecutables: canonicalExecutables,
      allowedDirectories: canonicalDirectories,
      updatedAt,
    };
    const write = this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const current = yield* this.#readPolicy();
        const agents = { ...current.agents, [input.agentId]: stored };
        yield* writeJsonFileAtomically(this.#path, { version: POLICY_VERSION, agents }, { createDirectory: true }).pipe(
          Effect.mapError((failure) => new RemoteDeviceCommandHostError("storage", failure.cause)),
        );
        return this.#permission(input.agentId, stored);
      }),
    );
    return yield* write;
  });

  readonly run = Effect.fn("RemoteDeviceCommandHost.run")(function* (
    this: RemoteDeviceCommandHost,
    input: RemoteDeviceCommandInput,
  ): Effect.fn.Return<RemoteDeviceCommandResult, RemoteDeviceCommandHostError> {
    if (!isAgentId(input.agentId)) return yield* new RemoteDeviceCommandHostError("invalid");
    const policy = yield* this.#readPolicy();
    const stored = policy.agents[input.agentId];
    const permission = this.#permission(input.agentId, stored);
    if (!permission.commandsEnabled) return yield* new RemoteDeviceCommandHostError("permission");
    if (!validExecutableName(input.executable)) return yield* new RemoteDeviceCommandHostError("invalid");
    if (!validArgs(input.args)) return yield* new RemoteDeviceCommandHostError("invalid");
    const grantedExecutable = stored?.allowedExecutables.find((candidate) =>
      this.#platform === "win32"
        ? candidate.name.toLowerCase() === input.executable.toLowerCase()
        : candidate.name === input.executable,
    );
    if (!grantedExecutable) return yield* new RemoteDeviceCommandHostError("permission");
    if (remoteCommandRequiresAutoReview(input.executable, input.args)) {
      return yield* new RemoteDeviceCommandHostError("review");
    }

    if (this.#platform !== "win32" && this.#platform !== "linux") {
      return yield* new RemoteDeviceCommandHostError("unsupported");
    }
    const directory = yield* Effect.tryPromise({
      try: () => canonicalWorkingDirectory(input.workingDirectory, permission.allowedDirectories, this.#platform),
      catch: (cause) =>
        cause instanceof RemoteDeviceCommandHostError ? cause : new RemoteDeviceCommandHostError("permission"),
    });
    const executable = yield* Effect.tryPromise({
      try: () => verifyGrantedExecutable(grantedExecutable.path, this.#platform),
      catch: () => new RemoteDeviceCommandHostError("unavailable"),
    });
    const result = yield* Effect.tryPromise({
      try: () => runProcess(executable, input.args, directory, this.#platform),
      catch: () => new RemoteDeviceCommandHostError("execution"),
    });
    return result;
  });

  readonly listComputerUseTools = Effect.fn("RemoteDeviceCommandHost.listComputerUseTools")(function* (
    this: RemoteDeviceCommandHost,
    agentId: string,
  ): Effect.fn.Return<RemoteDeviceComputerUseTool[], RemoteDeviceCommandHostError> {
    const permission = yield* this.getPermission(agentId);
    if (!permission.computerUseEnabled) return yield* new RemoteDeviceCommandHostError("permission");
    const config = this.#cuaDriver.mcpServerForProviders();
    if (!config) return yield* new RemoteDeviceCommandHostError("unavailable");
    return yield* Effect.tryPromise({
      try: async (signal) => {
        return await withCuaClient(
          config,
          async (connected, signal) => {
            const { tools } = await connected.listTools(undefined, { signal });
            return tools.slice(0, 128).map((tool) => ({
              name: tool.name.slice(0, 128),
              description: (tool.description ?? "").slice(0, 2_048),
            }));
          },
          signal,
        );
      },
      catch: () => new RemoteDeviceCommandHostError("unavailable"),
    });
  });

  readonly callComputerUse = Effect.fn("RemoteDeviceCommandHost.callComputerUse")(function* (
    this: RemoteDeviceCommandHost,
    input: DeviceCommandComputerUseInput,
  ): Effect.fn.Return<RemoteDeviceComputerUseResult, RemoteDeviceCommandHostError> {
    const permission = yield* this.getPermission(input.agentId);
    if (!permission.computerUseEnabled) return yield* new RemoteDeviceCommandHostError("permission");
    const config = this.#cuaDriver.mcpServerForProviders();
    if (!config) return yield* new RemoteDeviceCommandHostError("unavailable");
    return yield* Effect.tryPromise({
      try: (signal) =>
        withCuaClient(
          config,
          async (client, signal) => {
            const { tools } = await client.listTools(undefined, { signal });
            if (!tools.some((candidate) => candidate.name === input.tool)) {
              throw new Error("Requested Computer Use tool is not available.");
            }
            const result = await client.callTool({ name: input.tool, arguments: input.arguments }, undefined, {
              signal,
            });
            if (!isCallToolResult(result)) throw new Error("Computer Use returned no tool result.");
            return { success: !result.isError, contentItems: cuaContentItems(result) };
          },
          signal,
        ),
      catch: () => new RemoteDeviceCommandHostError("unavailable"),
    });
  });

  readonly #readPolicy = Effect.fn("RemoteDeviceCommandHost.readPolicy")(function* (
    this: RemoteDeviceCommandHost,
  ): Effect.fn.Return<DeviceCommandPolicyFile, RemoteDeviceCommandHostError> {
    const loaded = yield* Effect.result(readPreferenceFile(this.#path, decodePolicyFile));
    if (Result.isSuccess(loaded)) return loaded.success;
    const failure = loaded.failure;
    if (failure._tag === "PreferenceFileFailure" && isMissingFileError(failure.cause)) {
      return { version: POLICY_VERSION, agents: {} };
    }
    return yield* new RemoteDeviceCommandHostError("storage", failure);
  });

  readonly #readDevicePolicy = Effect.fn("RemoteDeviceCommandHost.readDevicePolicy")(function* (
    this: RemoteDeviceCommandHost,
  ): Effect.fn.Return<DeviceWidePolicyFile, RemoteDeviceCommandHostError> {
    const loaded = yield* Effect.result(readPreferenceFile(this.#devicePolicyPath, decodeDeviceWidePolicy));
    if (Result.isSuccess(loaded)) return loaded.success;
    const failure = loaded.failure;
    if (failure._tag === "PreferenceFileFailure" && isMissingFileError(failure.cause)) {
      return { version: 1, commandsEnabled: false, computerUseEnabled: false, updatedAt: "" };
    }
    return yield* new RemoteDeviceCommandHostError("storage", failure);
  });

  #permission(agentId: string, stored?: StoredPermission): RemoteDeviceCommandPermission {
    return {
      agentId,
      commandsEnabled: stored?.commandsEnabled ?? false,
      computerUseEnabled: stored?.computerUseEnabled ?? false,
      allowedExecutables: (stored?.allowedExecutables ?? []).map((executable) => executable.name),
      allowedDirectories: [...(stored?.allowedDirectories ?? [])],
      updatedAt: stored?.updatedAt ?? null,
    };
  }
}

function decodePolicyFile(value: unknown): DeviceCommandPolicyFile {
  if (!isDynamicRecord(value) || value.version !== POLICY_VERSION || !isDynamicRecord(value.agents)) {
    throw new Error("Invalid remote device permissions.");
  }
  const agents: Record<string, StoredPermission> = {};
  for (const [agentId, candidate] of Object.entries(value.agents)) {
    if (!isAgentId(agentId) || !isDynamicRecord(candidate)) throw new Error("Invalid remote device permissions.");
    const { commandsEnabled, computerUseEnabled, allowedExecutables, allowedDirectories } = candidate;
    const decodedExecutables = decodeStoredExecutables(allowedExecutables);
    if (
      !isBoolean(commandsEnabled) ||
      !isBoolean(computerUseEnabled) ||
      !Array.isArray(allowedDirectories) ||
      allowedDirectories.length > 32 ||
      !allowedDirectories.every((entry) => isString(entry) && isAbsolute(entry) && entry.length <= 4_096) ||
      !isString(candidate.updatedAt) ||
      candidate.updatedAt.length > 64
    ) {
      throw new Error("Invalid remote device permissions.");
    }
    agents[agentId] = {
      agentId,
      commandsEnabled,
      computerUseEnabled,
      allowedExecutables: decodedExecutables,
      allowedDirectories: [...allowedDirectories],
      updatedAt: candidate.updatedAt,
    };
  }
  return { version: POLICY_VERSION, agents };
}

function decodeDeviceWidePolicy(value: unknown): DeviceWidePolicyFile {
  if (
    !isDynamicRecord(value) ||
    value.version !== 1 ||
    !isBoolean(value.commandsEnabled) ||
    !isBoolean(value.computerUseEnabled) ||
    !isString(value.updatedAt) ||
    value.updatedAt.length > 64
  ) {
    throw new Error("Invalid device-wide remote permissions.");
  }
  return {
    version: 1,
    commandsEnabled: value.commandsEnabled,
    computerUseEnabled: value.computerUseEnabled,
    updatedAt: value.updatedAt,
  };
}

function defaultEnvironment(platform: NodeJS.Platform): Record<string, string> {
  const names =
    platform === "win32"
      ? ["SystemRoot", "windir", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATH"]
      : ["HOME", "USER", "PATH", "TMPDIR", "LANG", "LC_ALL"];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function decodeStoredExecutables(value: unknown): StoredExecutable[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid remote device permissions.");
  return value.map((entry) => {
    if (
      !isDynamicRecord(entry) ||
      !isString(entry.name) ||
      !validExecutableName(entry.name) ||
      !isString(entry.path) ||
      !isAbsolute(entry.path) ||
      entry.path.length > 4_096
    ) {
      throw new Error("Invalid remote device permissions.");
    }
    return { name: entry.name, path: entry.path };
  });
}

async function resolveAllowedExecutables(
  values: readonly string[],
  platform: NodeJS.Platform,
): Promise<StoredExecutable[]> {
  const seen = new Set<string>();
  const result: StoredExecutable[] = [];
  for (const original of values) {
    const name = original.trim();
    if (!validExecutableName(name)) throw new Error("Invalid executable name.");
    const key = platform === "win32" ? name.toLowerCase() : name;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, path: await resolveExecutable(name, platform) });
  }
  return result;
}

function validExecutableName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.+-]+$/u.test(value);
}

function validArgs(args: readonly string[]): boolean {
  return (
    args.length <= MAX_COMMAND_ARGUMENTS &&
    args.every((argument) => argument.length <= MAX_ARGUMENT_LENGTH && !argument.includes("\0")) &&
    args.reduce((total, argument) => total + argument.length, 0) <= 16_384
  );
}

async function resolveAllowedDirectories(values: readonly string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const value of values.slice(0, 32)) {
    if (!isAbsolute(value) || value.length > 4_096) throw new Error("Invalid allowed directory.");
    const path = await realpath(value);
    if (!(await stat(path)).isDirectory()) throw new Error("Allowed path is not a directory.");
    if (!canonical.includes(path)) canonical.push(path);
  }
  return canonical;
}

async function canonicalWorkingDirectory(
  value: string,
  roots: readonly string[],
  platform: NodeJS.Platform,
): Promise<string> {
  if (!isAbsolute(value) || value.length > 4_096) throw new RemoteDeviceCommandHostError("invalid");
  let path: string;
  try {
    path = await realpath(value);
    if (!(await stat(path)).isDirectory()) throw new Error("Not a directory.");
    const allowed = await Promise.all(
      roots.map(async (root) => {
        const resolvedRoot = await realpath(root);
        return samePath(resolvedRoot, root, platform) && isWithinDirectory(root, path, platform);
      }),
    );
    if (!allowed.some(Boolean)) throw new Error("Outside allowed directories.");
    return path;
  } catch {
    throw new RemoteDeviceCommandHostError("permission");
  }
}

async function canonicalWorkingDirectoryUnrestricted(value: string): Promise<string> {
  if (!isAbsolute(value) || value.length > 4_096 || value.includes("\0")) {
    throw new RemoteDeviceCommandHostError("invalid");
  }
  try {
    const path = await realpath(value);
    if (!(await stat(path)).isDirectory()) throw new Error("Not a directory.");
    return path;
  } catch {
    throw new RemoteDeviceCommandHostError("invalid");
  }
}

function isWithinDirectory(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const rootPath = platform === "win32" ? root.toLowerCase() : root;
  const candidatePath = platform === "win32" ? candidate.toLowerCase() : candidate;
  const fromRoot = relative(rootPath, candidatePath);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function resolveExecutable(value: string, platform: NodeJS.Platform): Promise<string> {
  const env = defaultEnvironment(platform);
  const pathValue = env.PATH ?? env.Path ?? "";
  const directories = pathValue
    .split(delimiter)
    .filter((directory) => directory && directory !== "." && isAbsolute(directory));
  const suffixes = platform === "win32" && !/\.(exe|com)$/iu.test(value) ? [".exe", ".com"] : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = resolve(directory, `${value}${suffix}`);
      try {
        const resolved = await realpath(candidate);
        const details = await stat(resolved);
        if (!details.isFile()) continue;
        await access(resolved, platform === "win32" ? constants.F_OK : constants.X_OK);
        const resolvedName = basename(resolved);
        const expectedName = `${value}${suffix}`;
        if (
          platform === "win32"
            ? resolvedName.toLowerCase() !== expectedName.toLowerCase()
            : resolvedName !== expectedName
        ) {
          continue;
        }
        return resolved;
      } catch {
        // This path did not contain a usable executable; keep searching the filtered PATH.
      }
    }
  }
  throw new RemoteDeviceCommandHostError("unavailable");
}

async function verifyGrantedExecutable(value: string, platform: NodeJS.Platform): Promise<string> {
  const resolved = await realpath(value);
  const samePath = platform === "win32" ? resolved.toLowerCase() === value.toLowerCase() : resolved === value;
  if (!samePath || !(await stat(resolved)).isFile()) throw new Error("The granted executable changed.");
  await access(resolved, platform === "win32" ? constants.F_OK : constants.X_OK);
  return resolved;
}

function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  platform: NodeJS.Platform,
): Promise<RemoteDeviceCommandResult> {
  return new Promise((resolveResult, reject) => {
    const startedAt = Date.now();
    const child = spawn(executable, [...args], {
      cwd,
      shell: false,
      detached: platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: defaultEnvironment(platform),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputLimitReached = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, platform);
      scheduleForceKill();
    }, MAX_COMMAND_RUNTIME_MS);
    const scheduleForceKill = () => {
      if (!forceKillTimer) forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };

    const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (settled || outputLimitReached) return;
      const remaining = MAX_CAPTURED_OUTPUT - (target === "stdout" ? stdout.length : stderr.length);
      const decoded = chunk.toString("utf8");
      if (decoded.length > remaining) {
        if (target === "stdout") stdout += decoded.slice(0, Math.max(0, remaining));
        else stderr += decoded.slice(0, Math.max(0, remaining));
        outputLimitReached = true;
        killProcessTree(child, platform);
        scheduleForceKill();
      } else if (target === "stdout") stdout += decoded;
      else stderr += decoded;
    };
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", () => {
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(new RemoteDeviceCommandHostError("execution"));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (outputLimitReached) {
        const marker = "\n[Output limit reached. The process was stopped.]";
        stderr = `${stderr.slice(0, Math.max(0, MAX_CAPTURED_OUTPUT - marker.length))}${marker}`;
      }
      resolveResult({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

function killProcessTree(child: ReturnType<typeof spawn>, platform: NodeJS.Platform): void {
  if (child.pid === undefined) return;
  if (platform === "win32") {
    const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    const taskkillPath = join(root, "System32", "taskkill.exe");
    const killer = spawn(taskkillPath, ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill("SIGKILL"));
    killer.once("close", (exitCode) => {
      if (exitCode !== 0) child.kill("SIGKILL");
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function withCuaClient<A>(
  config: NonNullable<ReturnType<CuaDriverRuntime["mcpServerForProviders"]>>,
  use: (client: Client, signal: AbortSignal) => Promise<A>,
  parentSignal: AbortSignal,
): Promise<A> {
  const client = new Client({ name: "openbot-remote-device", version: "1" }, { capabilities: {} });
  const env = { ...getDefaultEnvironment() };
  for (const name of config.envPassthrough) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const entry of config.env) env[entry.key] = entry.value;
  env[EMBEDDED_DRIVER_ENV] = "1";
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...config.args],
    cwd: config.workingDirectory || undefined,
    env,
    stderr: "ignore",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_CUA_REQUEST_MS);
  const signal = AbortSignal.any([controller.signal, parentSignal]);
  try {
    await client.connect(transport, { signal });
    return await use(client, signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    const pid = transport.pid;
    if (pid !== null) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The transport already stopped its child.
      }
    }
  }
}

function cuaContentItems(result: CallToolResult): RemoteDeviceComputerUseContentItem[] {
  const items: RemoteDeviceComputerUseContentItem[] = [];
  for (const item of result.content) {
    if (item.type === "text") {
      const text = item.text.slice(0, MAX_CUA_TEXT);
      items.push({ type: "inputText", text });
    } else if (item.type === "image" && item.data.length <= MAX_CUA_IMAGE_URL) {
      const imageUrl = `data:${item.mimeType};base64,${item.data}`;
      if (imageUrl.length <= MAX_CUA_IMAGE_URL) items.push({ type: "inputImage", imageUrl });
    }
    if (items.length >= 8) break;
  }
  return items;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isDynamicRecord(value) && Array.isArray(value.content);
}

function isAgentId(value: string): boolean {
  return /^[A-Za-z0-9:_-]{1,128}$/u.test(value);
}
