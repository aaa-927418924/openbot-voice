import type {
  RemoteDeviceCommandPermission,
  RemoteDeviceCommandTargetInput,
  UpdateRemoteDeviceCommandTargetInput,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

export function decodeRemoteDeviceCommandTargetInput(value: unknown): RemoteDeviceCommandTargetInput {
  if (!isDynamicRecord(value) || !isString(value.serverId) || !isString(value.agentId)) {
    throw new Error("Invalid remote device target.");
  }
  return { serverId: identifier(value.serverId), agentId: identifier(value.agentId) };
}

export function decodeUpdateRemoteDeviceCommandTargetInput(value: unknown): UpdateRemoteDeviceCommandTargetInput {
  if (!isDynamicRecord(value) || !isString(value.serverId)) throw new Error("Invalid remote device target.");
  return {
    serverId: identifier(value.serverId),
    permission: decodePermission(value.permission),
  };
}

function decodePermission(value: unknown): Omit<RemoteDeviceCommandPermission, "updatedAt"> {
  if (
    !isDynamicRecord(value) ||
    !isString(value.agentId) ||
    typeof value.commandsEnabled !== "boolean" ||
    typeof value.computerUseEnabled !== "boolean" ||
    !Array.isArray(value.allowedExecutables) ||
    !Array.isArray(value.allowedDirectories) ||
    value.allowedExecutables.length > 64 ||
    value.allowedDirectories.length > 32
  ) {
    throw new Error("Invalid remote device permissions.");
  }
  return {
    agentId: identifier(value.agentId),
    commandsEnabled: value.commandsEnabled,
    computerUseEnabled: value.computerUseEnabled,
    allowedExecutables: value.allowedExecutables.map((item) => executable(item)),
    allowedDirectories: value.allowedDirectories.map((item) => directory(item)),
  };
}

function identifier(value: string): string {
  if (!value.length || value.length > 128 || hasControlCharacters(value)) throw new Error("Invalid identifier.");
  return value;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function executable(value: unknown): string {
  if (!isString(value) || !/^[A-Za-z0-9._+-]{1,128}$/u.test(value)) {
    throw new Error("Executable names must be exact names without path separators.");
  }
  return value;
}

function directory(value: unknown): string {
  if (!isString(value) || !value.length || value.length > 4_096 || value.includes("\u0000")) {
    throw new Error("Invalid allowed directory.");
  }
  return value;
}
