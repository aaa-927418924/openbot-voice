import type { ServerConnectionState } from "./ipc-team-host";
import type { DynamicRecord } from "./runtime-values";
import { isString } from "./runtime-values";

export function isRemoteDeviceCommandIdentifier(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9:_-]+$/u.test(value);
}

export function isRemoteDeviceCommandStringList(
  value: unknown,
  maximumCount: number,
  maximumLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumCount &&
    value.every((item) => isString(item) && item.length > 0 && item.length <= maximumLength)
  );
}

/** A server host that can accept explicitly granted commands from a coordinator agent. */
export interface RemoteDeviceCommandTarget {
  serverId: string;
  name: string;
  platform: "windows" | "linux";
  state: ServerConnectionState;
  computerUseAvailable: boolean;
  /** The target can review commands with local deterministic rules without a model call. */
  localReviewAvailable: boolean;
  /** True only for the local settings target. Local targets are never exposed to agents. */
  isLocal: boolean;
}

/** Target metadata plus the current agent's permission, exposed to that agent's tool only. */
export interface RemoteDeviceCommandAgentTarget extends Omit<RemoteDeviceCommandTarget, "isLocal"> {
  /** Null means the device answered but its current grants could not be read. */
  policy: RemoteDeviceCommandPolicy | null;
}

/** Device-wide permission state, stored and enforced by the target computer. */
export interface RemoteDeviceCommandPolicy {
  commandsEnabled: boolean;
  computerUseEnabled: boolean;
  updatedAt: string | null;
}

export interface UpdateRemoteDeviceCommandPolicyInput {
  commandsEnabled: boolean;
  computerUseEnabled: boolean;
}

export interface RemoteDeviceShareSettings {
  supported: boolean;
  enabled: boolean;
}

export interface SetRemoteDeviceShareSettingsInput {
  enabled: boolean;
}

/** Per coordinator-agent permission stored and enforced on the target host. */
export interface RemoteDeviceCommandPermission {
  agentId: string;
  commandsEnabled: boolean;
  computerUseEnabled: boolean;
  /** Exact executable basenames. Empty means no commands are allowed. */
  allowedExecutables: string[];
  /** Canonical directories in which a command may run. Empty means no commands are allowed. */
  allowedDirectories: string[];
  updatedAt: string | null;
}

export interface UpdateRemoteDeviceCommandPermissionInput {
  agentId: string;
  commandsEnabled: boolean;
  computerUseEnabled: boolean;
  allowedExecutables: string[];
  allowedDirectories: string[];
}

export interface RemoteDeviceCommandTargetInput {
  serverId: string;
}

export interface UpdateRemoteDeviceCommandTargetInput {
  serverId: string;
  policy: UpdateRemoteDeviceCommandPolicyInput;
}

/** One direct process invocation. The target always uses shell:false and a bounded lifetime. */
export interface RemoteDeviceCommandInput {
  agentId: string;
  executable: string;
  args: string[];
  workingDirectory: string;
}

export interface RunRemoteDeviceCommandInput extends RemoteDeviceCommandInput {
  serverId: string;
}

export interface RemoteDeviceCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RemoteDeviceComputerUseTool {
  name: string;
  description: string;
}

export interface RemoteDeviceComputerUseToolsInput {
  serverId: string;
  agentId: string;
}

export interface RemoteDeviceComputerUseCallInput {
  serverId: string;
  agentId: string;
  tool: string;
  arguments: DynamicRecord;
}

export type RemoteDeviceComputerUseContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export interface RemoteDeviceComputerUseResult {
  success: boolean;
  contentItems: RemoteDeviceComputerUseContentItem[];
}
