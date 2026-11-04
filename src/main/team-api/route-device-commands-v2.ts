import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  DEVICE_COMMANDS_V2_CAPABILITY,
  DEVICE_COMMANDS_V2_ROUTES,
} from "@openbot/contracts/team-protocol/device-commands-v2";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result } from "effect";
import type {
  DeviceCommandTargetService,
  DeviceCommandTargetServiceV2,
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
import { readJson, requireAdmin, stringArray, stringField } from "./request-helpers";

export interface DeviceCommandV2RouteDependencies {
  deviceCommands?: DeviceCommandTargetService | DeviceCommandTargetServiceV2;
}

/** Target-local, device-wide grants and operations. Commands always pass through target Codex AutoReview. */
export async function routeDeviceCommandsV2(
  context: TeamApiRequestContext,
  { deviceCommands }: DeviceCommandV2RouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, member, json } = context;
  const route = url.pathname;
  if (!Object.values(DEVICE_COMMANDS_V2_ROUTES).some((knownRoute) => knownRoute === route)) return "unmatched";
  const expectedMethod =
    route === DEVICE_COMMANDS_V2_ROUTES.info ||
    route === DEVICE_COMMANDS_V2_ROUTES.policy ||
    route === DEVICE_COMMANDS_V2_ROUTES.computerUseTools
      ? "GET"
      : "POST";
  if (method !== expectedMethod) return "unmatched";
  const operationId = remoteDeviceOperationId(request.headers[REMOTE_DEVICE_DIAGNOSTIC_OPERATION_HEADER]);
  const routeName = deviceCommandRouteLabel(route);
  const startedAt = Date.now();
  const hasCapability = capabilities.has(DEVICE_COMMANDS_V2_CAPABILITY);
  const serviceAvailable = Boolean(deviceCommands && isDeviceCommandV2Service(deviceCommands));
  const serverTag =
    serviceAvailable && deviceCommands && isDeviceCommandV2Service(deviceCommands)
      ? (deviceCommands.diagnosticTag?.() ?? undefined)
      : undefined;
  logger.info("Remote device API request reached the host.", {
    operationId,
    route: routeName,
    method,
    hasCapability,
    serviceAvailable,
    ...(serverTag ? { serverTag } : {}),
  });
  const respond = (status: number, value: object | null) => {
    logger.info("Remote device API request completed on the host.", {
      operationId,
      route: routeName,
      ...(serverTag ? { serverTag } : {}),
      httpStatus: status,
      durationMs: Date.now() - startedAt,
    });
    return json(status, value);
  };
  try {
    if (!hasCapability) throw new HttpError(404, sourceText("error.team.routeNotFound"));
    if (!serviceAvailable || !deviceCommands || !isDeviceCommandV2Service(deviceCommands)) {
      throw new HttpError(503, sourceText("error.team.requestFailed"));
    }
    if (route === DEVICE_COMMANDS_V2_ROUTES.updatePolicy) requireAdmin(member);

    if (method === "GET" && route === DEVICE_COMMANDS_V2_ROUTES.info) {
      return respond(200, await runDeviceCommandEffect(deviceCommands.infoV2()));
    }
    if (method === "GET" && route === DEVICE_COMMANDS_V2_ROUTES.policy) {
      return respond(200, await runDeviceCommandEffect(deviceCommands.getPolicy()));
    }
    if (method === "POST" && route === DEVICE_COMMANDS_V2_ROUTES.updatePolicy) {
      const body = await readJson(request);
      if (typeof body.commandsEnabled !== "boolean" || typeof body.computerUseEnabled !== "boolean") {
        throw new HttpError(400, sourceText("error.team.requestFailed"));
      }
      return respond(
        200,
        await runDeviceCommandEffect(
          deviceCommands.updatePolicy({
            commandsEnabled: body.commandsEnabled,
            computerUseEnabled: body.computerUseEnabled,
          }),
        ),
      );
    }
    if (method === "POST" && route === DEVICE_COMMANDS_V2_ROUTES.run) {
      const body = await readJson(request);
      return respond(
        200,
        await runDeviceCommandEffect(
          deviceCommands.runWithAutoReview({
            agentId: stringField(body, "agentId"),
            executable: stringField(body, "executable", false, 128),
            args: stringArray(body, "args", 64, 4_096),
            workingDirectory: stringField(body, "workingDirectory", false, 4_096),
          }),
        ),
      );
    }
    if (method === "GET" && route === DEVICE_COMMANDS_V2_ROUTES.computerUseTools) {
      return respond(200, { tools: await runDeviceCommandEffect(deviceCommands.listComputerUseToolsDeviceWide()) });
    }
    if (method === "POST" && route === DEVICE_COMMANDS_V2_ROUTES.computerUseCall) {
      const body = await readJson(request);
      const args = body.arguments;
      if (!isDynamicRecord(args)) throw new HttpError(400, sourceText("error.team.requestFailed"));
      return respond(
        200,
        await runDeviceCommandEffect(
          deviceCommands.callComputerUseDeviceWide({
            agentId: stringField(body, "agentId"),
            tool: stringField(body, "tool", false, 128),
            arguments: args,
          }),
        ),
      );
    }
    return "unmatched";
  } catch (error) {
    const mapped = error instanceof DeviceCommandHostError ? deviceCommandHttpError(error) : error;
    const httpStatus = mapped instanceof HttpError ? mapped.status : 500;
    logger.warn("Remote device API request failed on the host.", {
      operationId,
      route: routeName,
      ...(serverTag ? { serverTag } : {}),
      httpStatus,
      durationMs: Date.now() - startedAt,
      ...(error instanceof DeviceCommandHostError
        ? {
            failureKind: "host_rejected",
            failureReason: error.reason,
            ...(error.reason === "auto_review" &&
            error.cause instanceof Error &&
            error.cause.name === "CodexAutoReviewUnavailable" &&
            "stage" in error.cause &&
            typeof error.cause.stage === "string"
              ? { autoReviewStage: error.cause.stage }
              : {}),
          }
        : mapped instanceof HttpError
          ? { failureKind: "http_rejected" }
          : remoteDeviceFailureDetails(error)),
    });
    throw mapped;
  }
}

/** Keep typed host failures intact so this route can map them to public HTTP errors. */
async function runDeviceCommandEffect<A>(operation: Effect.Effect<A, DeviceCommandHostError>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

function deviceCommandRouteLabel(path: string) {
  if (path === DEVICE_COMMANDS_V2_ROUTES.info) return "target_info";
  if (path === DEVICE_COMMANDS_V2_ROUTES.policy) return "policy";
  if (path === DEVICE_COMMANDS_V2_ROUTES.updatePolicy) return "update_policy";
  if (path === DEVICE_COMMANDS_V2_ROUTES.run) return "run";
  if (path === DEVICE_COMMANDS_V2_ROUTES.computerUseTools) return "computer_use_tools";
  if (path === DEVICE_COMMANDS_V2_ROUTES.computerUseCall) return "computer_use_call";
  return "unknown_device_command_route";
}

export function isDeviceCommandV2Service(
  service: DeviceCommandTargetService | DeviceCommandTargetServiceV2 | undefined,
): service is DeviceCommandTargetServiceV2 {
  if (!service) return false;
  return (
    "infoV2" in service &&
    "getPolicy" in service &&
    "updatePolicy" in service &&
    "runWithAutoReview" in service &&
    "listComputerUseToolsDeviceWide" in service &&
    "callComputerUseDeviceWide" in service
  );
}

function deviceCommandHttpError(error: RemoteDeviceCommandHostError): HttpError {
  const status =
    error.reason === "permission"
      ? 403
      : error.reason === "invalid" || error.reason === "review"
        ? 400
        : error.reason === "unsupported"
          ? 404
          : error.reason === "unavailable" || error.reason === "auto_review"
            ? 503
            : 500;
  const message =
    error.reason === "permission"
      ? sourceText("error.computerUse.remoteDevicePermission")
      : error.reason === "review"
        ? sourceText("error.computerUse.remoteCommandBlocked")
        : error.reason === "auto_review"
          ? sourceText("error.computerUse.remoteAutoReviewUnavailable")
          : error.reason === "invalid"
            ? sourceText("error.computerUse.remoteCommandInvalid")
            : sourceText("error.computerUse.remoteOperationUnavailable");
  return new HttpError(status, message);
}
