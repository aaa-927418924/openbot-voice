import type { RemoteDeviceCommandResult } from "@openbot/contracts/ipc";
import {
  DEVICE_COMMANDS_V4_CAPABILITY,
  DEVICE_COMMANDS_V4_ROUTES,
} from "@openbot/contracts/team-protocol/device-commands-v4";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import type {
  DeviceCommandTargetService,
  DeviceCommandTargetServiceV2,
  DeviceCommandTargetServiceV3,
  DeviceCommandTargetServiceV4,
  RemoteDeviceCommandHostError,
} from "../remote-device-command-host";
import { RemoteDeviceCommandHostError as DeviceCommandHostError } from "../remote-device-command-host";
import {
  remoteDeviceDiagnosticsLogger as logger,
  REMOTE_DEVICE_DIAGNOSTIC_OPERATION_HEADER,
  remoteDeviceFailureDetails,
  remoteDeviceOperationId,
} from "../remote-device-diagnostics";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { booleanField, readJson, stringArray, stringField } from "./request-helpers";

export interface DeviceCommandV4RouteDependencies {
  deviceCommands?:
    | DeviceCommandTargetService
    | DeviceCommandTargetServiceV2
    | DeviceCommandTargetServiceV3
    | DeviceCommandTargetServiceV4;
}

/** V4 accepts a Cloud-reviewed command and repeats the catastrophic hard-deny on the target. */
export async function routeDeviceCommandsV4(
  context: TeamApiRequestContext,
  { deviceCommands }: DeviceCommandV4RouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  const route = url.pathname;
  if (route !== DEVICE_COMMANDS_V4_ROUTES.run || method !== "POST") return "unmatched";

  const operationId = remoteDeviceOperationId(request.headers[REMOTE_DEVICE_DIAGNOSTIC_OPERATION_HEADER]);
  const startedAt = Date.now();
  const deviceCommandService = isDeviceCommandV4Service(deviceCommands) ? deviceCommands : null;
  const serviceAvailable = deviceCommandService !== null;
  const serverTag = deviceCommandService?.diagnosticTag?.() ?? undefined;
  logger.info("Remote device V4 API request reached the host.", {
    operationId,
    route: "run_after_cloud_review",
    method,
    hasCapability: capabilities.has(DEVICE_COMMANDS_V4_CAPABILITY),
    serviceAvailable,
    ...(serverTag ? { serverTag } : {}),
  });
  const respond = (status: number, value: RemoteDeviceCommandResult) => {
    logger.info("Remote device V4 API request completed on the host.", {
      operationId,
      route: "run_after_cloud_review",
      ...(serverTag ? { serverTag } : {}),
      httpStatus: status,
      durationMs: Date.now() - startedAt,
    });
    return json(status, value);
  };

  try {
    if (!capabilities.has(DEVICE_COMMANDS_V4_CAPABILITY)) {
      throw new HttpError(404, sourceText("error.team.routeNotFound"));
    }
    if (!deviceCommandService) throw new HttpError(503, sourceText("error.team.requestFailed"));
    const body = await readJson(request);
    const safetyReviewed = booleanField(body, "safetyReviewed");
    if (!safetyReviewed) throw new HttpError(403, sourceText("error.computerUse.remoteCommandReviewBlocked"));
    return respond(
      200,
      await runDeviceCommandEffect(
        deviceCommandService.runAfterCloudReview({
          agentId: stringField(body, "agentId"),
          executable: stringField(body, "executable", false, 128),
          args: stringArray(body, "args", 64, 4_096),
          workingDirectory: stringField(body, "workingDirectory", false, 4_096),
          safetyReviewed,
        }),
      ),
    );
  } catch (error) {
    const mapped = error instanceof DeviceCommandHostError ? deviceCommandHttpError(error) : error;
    logger.warn("Remote device V4 API request failed on the host.", {
      operationId,
      route: "run_after_cloud_review",
      ...(serverTag ? { serverTag } : {}),
      httpStatus: mapped instanceof HttpError ? mapped.status : 500,
      durationMs: Date.now() - startedAt,
      ...(error instanceof DeviceCommandHostError
        ? { failureKind: "host_rejected", failureReason: error.reason }
        : mapped instanceof HttpError
          ? { failureKind: "http_rejected" }
          : remoteDeviceFailureDetails(error)),
    });
    throw mapped;
  }
}

export function isDeviceCommandV4Service(
  service: DeviceCommandV4RouteDependencies["deviceCommands"],
): service is DeviceCommandTargetServiceV4 {
  return Boolean(service && "runAfterCloudReview" in service);
}

async function runDeviceCommandEffect<A>(operation: Effect.Effect<A, DeviceCommandHostError>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

function deviceCommandHttpError(error: RemoteDeviceCommandHostError): HttpError {
  const status =
    error.reason === "permission" || error.reason === "review"
      ? 403
      : error.reason === "invalid"
        ? 400
        : error.reason === "unsupported"
          ? 404
          : error.reason === "unavailable"
            ? 503
            : 500;
  const message =
    error.reason === "permission"
      ? sourceText("error.computerUse.remoteDevicePermission")
      : error.reason === "review"
        ? sourceText("error.computerUse.remoteCommandReviewBlocked")
        : error.reason === "invalid"
          ? sourceText("error.computerUse.remoteCommandInvalid")
          : sourceText("error.computerUse.remoteOperationUnavailable");
  return new HttpError(status, message);
}
