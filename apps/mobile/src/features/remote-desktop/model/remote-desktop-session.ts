import { REMOTE_DESKTOP_ERROR_CODES, type RemoteDesktopSession } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

function isRemoteDesktopPhase(value: unknown): value is RemoteDesktopSession["phase"] {
  return (
    value === "starting_host" ||
    value === "connecting" ||
    value === "connected" ||
    value === "disconnecting" ||
    value === "error"
  );
}

function isRemoteDesktopTransport(value: unknown): value is RemoteDesktopSession["transport"] {
  return value === "unknown" || value === "p2p" || value === "relay";
}

function isRemoteDesktopErrorCode(value: unknown): value is RemoteDesktopSession["errorCode"] {
  return value === null || REMOTE_DESKTOP_ERROR_CODES.some((code) => code === value);
}

export function decodeRemoteDesktopSession(value: unknown): RemoteDesktopSession {
  if (!isDynamicRecord(value)) throw new Error("The host returned an invalid remote desktop session.");
  const url = isString(value.viewerUrl) ? new URL(value.viewerUrl) : null;
  if (
    !isString(value.id) ||
    !isString(value.serverId) ||
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    !isString(value.viewerGrant) ||
    !Array.isArray(value.displays) ||
    !isRemoteDesktopPhase(value.phase) ||
    !isRemoteDesktopTransport(value.transport) ||
    !isRemoteDesktopErrorCode(value.errorCode) ||
    (value.selectedDisplayId !== null && !isString(value.selectedDisplayId)) ||
    (value.message !== null && !isString(value.message)) ||
    !isString(value.createdAt) ||
    !isString(value.grantExpiresAt)
  ) {
    throw new Error("The host returned an invalid remote desktop session.");
  }
  const displays = value.displays.map((item) => {
    if (
      !isDynamicRecord(item) ||
      !isString(item.id) ||
      !isString(item.label) ||
      !isNumber(item.width) ||
      !isNumber(item.height) ||
      !isBoolean(item.primary)
    ) {
      throw new Error("The host returned an invalid remote desktop display.");
    }
    return { id: item.id, label: item.label, width: item.width, height: item.height, primary: item.primary };
  });
  return {
    id: value.id,
    serverId: value.serverId,
    viewerUrl: url.toString(),
    viewerGrant: value.viewerGrant,
    displays,
    selectedDisplayId: value.selectedDisplayId,
    phase: value.phase,
    transport: value.transport,
    errorCode: value.errorCode,
    message: value.message,
    createdAt: value.createdAt,
    grantExpiresAt: value.grantExpiresAt,
  };
}
