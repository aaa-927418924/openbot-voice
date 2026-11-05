import { createHash, randomUUID } from "node:crypto";
import { createOpenBotLogger } from "@openbot/logging";
import { CentralAuthOperationError } from "./central-auth-effects";
import { RemoteProtocolError, RemoteRequestError } from "./remote-server-errors";
import { RemoteWorkflowError } from "./remote-service-effects";

export const remoteDeviceDiagnosticsLogger = createOpenBotLogger("remote-device-diagnostics");

export const REMOTE_DEVICE_DIAGNOSTIC_OPERATION_HEADER = "x-openbot-remote-device-operation-id";

const REMOTE_DEVICE_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class RemoteDeviceDiagnosticError extends Error {
  constructor(
    readonly diagnosticKind:
      | "account_session_refresh_incomplete"
      | "account_session_refresh_account_unavailable"
      | "invalid_target_info"
      | "invalid_policy_response"
      | "capability_unavailable",
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
    if (cause instanceof RemoteWorkflowError || cause instanceof CentralAuthOperationError) {
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
  // Central account API failures are wrapped in CentralAuthOperationError. Keep the diagnostic
  // useful without recording exception text, endpoint paths, account IDs, or credentials.
  if (cause instanceof Error && cause.name === "AuthApiError") {
    const status = "status" in cause && typeof cause.status === "number" ? cause.status : undefined;
    const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
    return {
      failureKind: "account_http",
      ...(status === undefined ? {} : { httpStatus: status }),
      ...(code && /^[a-z0-9_]{1,64}$/iu.test(code) ? { protocolCode: code } : {}),
    };
  }
  if (cause instanceof TypeError) return { failureKind: "network" };
  if (cause instanceof Error && cause.name === "Error") return { failureKind: "account_error" };
  return { failureKind: "unexpected" };
}
