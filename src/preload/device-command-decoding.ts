import type { RemoteDeviceCommandPermission, RemoteDeviceCommandTarget } from "@openbot/contracts/ipc";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";

const serverStates = ["online", "connecting", "offline", "error", "incompatible"] as const;

export function decodeRemoteDeviceCommandTargets(value: unknown): RemoteDeviceCommandTarget[] {
  if (!Array.isArray(value)) throw new Error("Invalid remote device list response.");
  return value.map((item) => {
    if (
      !isDynamicRecord(item) ||
      !identifier(item.serverId) ||
      !isString(item.name) ||
      item.name.length > 128 ||
      (item.platform !== "windows" && item.platform !== "linux") ||
      !isOneOf(serverStates, item.state) ||
      typeof item.computerUseAvailable !== "boolean"
    ) {
      throw new Error("Invalid remote device list response.");
    }
    return {
      serverId: item.serverId,
      name: item.name,
      platform: item.platform,
      state: item.state,
      computerUseAvailable: item.computerUseAvailable,
    };
  });
}

export function decodeRemoteDeviceCommandPermission(value: unknown): RemoteDeviceCommandPermission {
  if (
    !isDynamicRecord(value) ||
    !identifier(value.agentId) ||
    typeof value.commandsEnabled !== "boolean" ||
    typeof value.computerUseEnabled !== "boolean" ||
    !stringList(value.allowedExecutables, 64, 128) ||
    !stringList(value.allowedDirectories, 32, 4_096) ||
    (value.updatedAt !== null && !isString(value.updatedAt))
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

function identifier(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9:_-]+$/u.test(value);
}

function stringList(value: unknown, maximumCount: number, maximumLength: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumCount &&
    value.every((item) => isString(item) && item.length > 0 && item.length <= maximumLength)
  );
}
