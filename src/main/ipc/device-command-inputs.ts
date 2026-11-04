import type {
  RemoteDeviceCommandTargetInput,
  SetRemoteDeviceShareSettingsInput,
  UpdateRemoteDeviceCommandTargetInput,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

export function decodeRemoteDeviceCommandTargetInput(value: unknown): RemoteDeviceCommandTargetInput {
  if (!isDynamicRecord(value) || !isString(value.serverId)) throw new Error("Invalid remote device target.");
  return { serverId: identifier(value.serverId) };
}

export function decodeUpdateRemoteDeviceCommandTargetInput(value: unknown): UpdateRemoteDeviceCommandTargetInput {
  if (
    !isDynamicRecord(value) ||
    !isString(value.serverId) ||
    !isDynamicRecord(value.policy) ||
    typeof value.policy.commandsEnabled !== "boolean" ||
    typeof value.policy.computerUseEnabled !== "boolean"
  ) {
    throw new Error("Invalid remote device permissions.");
  }
  return {
    serverId: identifier(value.serverId),
    policy: {
      commandsEnabled: value.policy.commandsEnabled,
      computerUseEnabled: value.policy.computerUseEnabled,
    },
  };
}

export function decodeSetRemoteDeviceShareSettingsInput(value: unknown): SetRemoteDeviceShareSettingsInput {
  if (!isDynamicRecord(value) || typeof value.enabled !== "boolean") {
    throw new Error("Invalid remote device sharing setting.");
  }
  return { enabled: value.enabled };
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
