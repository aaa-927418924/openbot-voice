import { createHash, randomUUID } from "node:crypto";
import { createOpenBotLogger } from "@openbot/logging";
import { RemoteProtocolError, RemoteRequestError } from "./remote-server-errors";
import { RemoteWorkflowError } from "./remote-service-effects";

export const remoteDeviceDiagnosticsLogger = createOpenBotLogger("remote-device-diagnostics");

export const REMOTE_DEVICE_DIAGNOSTIC_OPERATION_HEADER = "x-openbot-remote-device-operation-id";

const REMOTE_DEVICE_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class RemoteDeviceDiagnosticError extends Error {
  constructor(
    readonly diagnosticKind: "invalid_target_info" | "invalid_policy_response" | "capability_unavailable",
    message = "Remote device response did not match the expected shape.",
  ) {
    super(message);
  }
}

/** A stable pseudonymous tag lets two devices' local logs be compared without printing a device ID. */
export function remoteDeviceTag(serverId: string): string {
  return createHash("sha256").update(serverId).digest("hex").slice(0, 16);
}

export function isRemoteDeviceOperationId(value: unknown): value is string {
  return typeof value === "string" && REMOTE_DEVICE_OPERATION_ID_PATTERN.test(value);
}

export function remoteDeviceOperationId(candidate?: unknown): string {
  return isRemoteDeviceOperationId(candidate) ? candidate : randomUUID();
}

/** Hashes only an endpoint origin, so logs can distinguish stale addresses without storing them. */
export function remoteDeviceEndpointTag(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  try {
    return createHash("sha256").update(new URL(endpoint).origin).digest("hex").slice(0, 16);
  } catch {
    return "invalid_endpoint";
  }
}

/** Classifies known transport failures without persisting exception text, URLs, or request data. */
export function remoteDeviceFailureDetails(error: unknown): {
  failureKind: string;
  httpStatus?: number;
  protocolCode?: string;
} {
  let cause = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (cause instanceof RemoteWorkflowError) {
      cause = cause.cause;
      continue;
    }
    break;
  }
  if (cause instanceof RemoteDeviceDiagnosticError) return { failureKind: cause.diagnosticKind };
  if (cause instanceof RemoteRequestError) return { failureKind: "http", httpStatus: cause.status };
  if (cause instanceof RemoteProtocolError) {
    if (cause.cause instanceof RemoteDeviceDiagnosticError) {
      return { failureKind: cause.cause.diagnosticKind, protocolCode: cause.code };
    }
    return { failureKind: "protocol", protocolCode: cause.code };
  }
  if (cause instanceof TypeError) return { failureKind: "network" };
  return { failureKind: "unexpected" };
}
