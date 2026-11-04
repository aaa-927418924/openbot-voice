import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  DEVICE_COMMANDS_V2_CAPABILITY,
  DEVICE_COMMANDS_V2_ROUTES,
} from "@openbot/contracts/team-protocol/device-commands-v2";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type {
  DeviceCommandTargetService,
  DeviceCommandTargetServiceV2,
  RemoteDeviceCommandHostError,
} from "../remote-device-command-host";
import { RemoteDeviceCommandHostError as DeviceCommandHostError } from "../remote-device-command-host";
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
  if (!capabilities.has(DEVICE_COMMANDS_V2_CAPABILITY)) {
    throw new HttpError(404, sourceText("error.team.routeNotFound"));
  }
  if (!deviceCommands || !isDeviceCommandV2Service(deviceCommands)) {
    throw new HttpError(503, sourceText("error.team.requestFailed"));
  }
  if (route === DEVICE_COMMANDS_V2_ROUTES.updatePolicy) requireAdmin(member);

  try {
    if (method === "GET" && route === DEVICE_COMMANDS_V2_ROUTES.info) {
      return json(200, await runCauseEffect(deviceCommands.infoV2()));
    }
    if (method === "GET" && route === DEVICE_COMMANDS_V2_ROUTES.policy) {
      return json(200, await runCauseEffect(deviceCommands.getPolicy()));
    }
    if (method === "POST" && route === DEVICE_COMMANDS_V2_ROUTES.updatePolicy) {
      const body = await readJson(request);
      if (typeof body.commandsEnabled !== "boolean" || typeof body.computerUseEnabled !== "boolean") {
        throw new HttpError(400, sourceText("error.team.requestFailed"));
      }
      return json(
        200,
        await runCauseEffect(
          deviceCommands.updatePolicy({
            commandsEnabled: body.commandsEnabled,
            computerUseEnabled: body.computerUseEnabled,
          }),
        ),
      );
    }
    if (method === "POST" && route === DEVICE_COMMANDS_V2_ROUTES.run) {
      const body = await readJson(request);
      return json(
        200,
        await runCauseEffect(
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
      return json(200, { tools: await runCauseEffect(deviceCommands.listComputerUseToolsDeviceWide()) });
    }
    if (method === "POST" && route === DEVICE_COMMANDS_V2_ROUTES.computerUseCall) {
      const body = await readJson(request);
      const args = body.arguments;
      if (!isDynamicRecord(args)) throw new HttpError(400, sourceText("error.team.requestFailed"));
      return json(
        200,
        await runCauseEffect(
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
    if (error instanceof DeviceCommandHostError) throw deviceCommandHttpError(error);
    throw error;
  }
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
