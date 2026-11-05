import type { RemoteDeviceCommandResult } from "@openbot/contracts/ipc";
import {
  DEVICE_COMMANDS_V3_CAPABILITY,
  DEVICE_COMMANDS_V3_ROUTES,
} from "@openbot/contracts/team-protocol/device-commands-v3";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import type {
  DeviceCommandTargetService,
  DeviceCommandTargetServiceV2,
  DeviceCommandTargetServiceV3,
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
import { readJson, stringArray, stringField } from "./request-helpers";

export interface DeviceCommandV3RouteDependencies {
  deviceCommands?: DeviceCommandTargetService | DeviceCommandTargetServiceV2 | DeviceCommandTargetServiceV3;
}

type DeviceCommandV3Response =
  | {
      serverId: string;
      name: string;
      deviceName: string;
      platform: "windows" | "linux";
      computerUseAvailable: boolean;
      localReviewAvailable: boolean;
    }
  | RemoteDeviceCommandResult;

/** The V3 command route performs deterministic, target-local review without calling a model. */
export async function routeDeviceCommandsV3(
  context: TeamApiRequestContext,
  { deviceCommands }: DeviceCommandV3RouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  const route = url.pathname;
  if (route !== DEVICE_COMMANDS_V3_ROUTES.info && route !== DEVICE_COMMANDS_V3_ROUTES.run) return "unmatched";
  const expectedMethod = route === DEVICE_COMMANDS_V3_ROUTES.info ? "GET" : "POST";
  if (method !== expectedMethod) return "unmatched";

  const operationId = remoteDeviceOperationId(request.headers[REMOTE_DEVICE_DIAGNOSTIC_OPERATION_HEADER]);
  const routeName = route === DEVICE_COMMANDS_V3_ROUTES.info ? "target_info_local_review" : "run_local_review";
  const startedAt = Date.now();
  const deviceCommandService = isDeviceCommandV3Service(deviceCommands) ? deviceCommands : null;
  const serviceAvailable = deviceCommandService !== null;
  const serverTag = deviceCommandService?.diagnosticTag?.() ?? undefined;
  logger.info("Remote device V3 API request reached the host.", {
    operationId,
    route: routeName,
    method,
    hasCapability: capabilities.has(DEVICE_COMMANDS_V3_CAPABILITY),
    serviceAvailable,
    ...(serverTag ? { serverTag } : {}),
  });
  const respond = (status: number, value: DeviceCommandV3Response) => {
    logger.info("Remote device V3 API request completed on the host.", {
      operationId,
      route: routeName,
      ...(serverTag ? { serverTag } : {}),
      httpStatus: status,
      durationMs: Date.now() - startedAt,
    });
    return json(status, value);
  };

  try {
    if (!capabilities.has(DEVICE_COMMANDS_V3_CAPABILITY)) {
      throw new HttpError(404, sourceText("error.team.routeNotFound"));
    }
    if (!deviceCommandService) {
      throw new HttpError(503, sourceText("error.team.requestFailed"));
    }
    if (route === DEVICE_COMMANDS_V3_ROUTES.info) {
      return respond(200, await runDeviceCommandEffect(deviceCommandService.infoV3()));
    }
    const body = await readJson(request);
    return respond(
      200,
      await runDeviceCommandEffect(
        deviceCommandService.runWithLocalReview({
          agentId: stringField(body, "agentId"),
          executable: stringField(body, "executable", false, 128),
          args: stringArray(body, "args", 64, 4_096),
          workingDirectory: stringField(body, "workingDirectory", false, 4_096),
        }),
      ),
    );
  } catch (error) {
    const mapped = error instanceof DeviceCommandHostError ? deviceCommandHttpError(error) : error;
    logger.warn("Remote device V3 API request failed on the host.", {
      operationId,
      route: routeName,
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

export function isDeviceCommandV3Service(
  service: DeviceCommandTargetService | DeviceCommandTargetServiceV2 | DeviceCommandTargetServiceV3 | undefined,
): service is DeviceCommandTargetServiceV3 {
  return Boolean(service && "infoV3" in service && "runWithLocalReview" in service);
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
