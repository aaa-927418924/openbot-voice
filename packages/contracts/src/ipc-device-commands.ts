import type { ServerConnectionState } from "./ipc-team-host";
import type { DynamicRecord } from "./runtime-values";

/** A server host that can accept explicitly granted commands from a coordinator agent. */
export interface RemoteDeviceCommandTarget {
  serverId: string;
  name: string;
  platform: "windows" | "linux";
  state: ServerConnectionState;
  computerUseAvailable: boolean;
}

/** Target metadata plus the current agent's permission, exposed to that agent's tool only. */
export interface RemoteDeviceCommandAgentTarget extends RemoteDeviceCommandTarget {
  permission: RemoteDeviceCommandPermission;
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
  agentId: string;
}

export interface UpdateRemoteDeviceCommandTargetInput {
  serverId: string;
  permission: UpdateRemoteDeviceCommandPermissionInput;
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
