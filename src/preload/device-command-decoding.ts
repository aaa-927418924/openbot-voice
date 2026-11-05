import {
  isRemoteDeviceCommandIdentifier,
  type RemoteDeviceCommandPolicy,
  type RemoteDeviceCommandTarget,
  type RemoteDeviceShareSettings,
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
      typeof item.localReviewAvailable !== "boolean" ||
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
      localReviewAvailable: item.localReviewAvailable,
      isLocal: item.isLocal,
    };
  });
}

export function decodeRemoteDeviceCommandPolicy(value: unknown): RemoteDeviceCommandPolicy {
  if (
    !isDynamicRecord(value) ||
    typeof value.commandsEnabled !== "boolean" ||
    typeof value.computerUseEnabled !== "boolean" ||
    (value.updatedAt !== null && !isString(value.updatedAt))
  ) {
    throw new Error("Invalid remote device policy response.");
  }
  return {
    commandsEnabled: value.commandsEnabled,
    computerUseEnabled: value.computerUseEnabled,
    updatedAt: value.updatedAt,
  };
}

export function decodeRemoteDeviceShareSettings(value: unknown): RemoteDeviceShareSettings {
  if (!isDynamicRecord(value) || typeof value.supported !== "boolean" || typeof value.enabled !== "boolean") {
    throw new Error("Invalid remote device sharing settings.");
  }
  return { supported: value.supported, enabled: value.enabled };
}
