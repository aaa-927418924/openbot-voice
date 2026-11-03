import {
  isRemoteDeviceCommandIdentifier,
  isRemoteDeviceCommandStringList,
  type RemoteDeviceCommandPermission,
  type RemoteDeviceCommandTarget,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";

const serverStates = ["online", "connecting", "offline", "error", "incompatible"] as const;

export function decodeRemoteDeviceCommandTargets(value: unknown): RemoteDeviceCommandTarget[] {
  if (!Array.isArray(value)) throw new Error("Invalid remote device list response.");
  return value.map((item) => {
    if (
      !isDynamicRecord(item) ||
      !isRemoteDeviceCommandIdentifier(item.serverId) ||
      !isString(item.name) ||
      item.name.length > 128 ||
      (item.platform !== "windows" && item.platform !== "linux") ||
      !isOneOf(serverStates, item.state) ||
      typeof item.computerUseAvailable !== "boolean" ||
      typeof item.isLocal !== "boolean"
    ) {
      throw new Error("Invalid remote device list response.");
    }
    return {
      serverId: item.serverId,
      name: item.name,
      platform: item.platform,
      state: item.state,
      computerUseAvailable: item.computerUseAvailable,
      isLocal: item.isLocal,
    };
  });
}

export function decodeRemoteDeviceCommandPermission(value: unknown): RemoteDeviceCommandPermission {
  if (
    !isDynamicRecord(value) ||
    !isRemoteDeviceCommandIdentifier(value.agentId) ||
    typeof value.commandsEnabled !== "boolean" ||
    typeof value.computerUseEnabled !== "boolean" ||
    !isRemoteDeviceCommandStringList(value.allowedExecutables, 64, 128) ||
    !isRemoteDeviceCommandStringList(value.allowedDirectories, 32, 4_096) ||
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
