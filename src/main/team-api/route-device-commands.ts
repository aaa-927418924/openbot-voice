import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { DEVICE_COMMAND_ROUTES, DEVICE_COMMANDS_CAPABILITY } from "@openbot/contracts/team-protocol/device-commands-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { DeviceCommandTargetService, RemoteDeviceCommandHostError } from "../remote-device-command-host";
import { RemoteDeviceCommandHostError as DeviceCommandHostError } from "../remote-device-command-host";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { pathIdentifier, readJson, stringArray, stringField } from "./request-helpers";

export interface DeviceCommandRouteDependencies {
  deviceCommands?: DeviceCommandTargetService;
}

/**
 * The device that receives a command is the only place that stores and checks its grant. Every
 * operation requires an authenticated administrator, and the service checks the per-agent grant.
 */
export async function routeDeviceCommands(
  context: TeamApiRequestContext,
  { deviceCommands }: DeviceCommandRouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, member, json } = context;
  const route = url.pathname;
  if (!Object.values(DEVICE_COMMAND_ROUTES).some((knownRoute) => knownRoute === route)) return "unmatched";
  const expectedMethod =
    route === DEVICE_COMMAND_ROUTES.info ||
    route === DEVICE_COMMAND_ROUTES.permissions ||
    route === DEVICE_COMMAND_ROUTES.computerUseTools
      ? "GET"
      : "POST";
  if (method !== expectedMethod) return "unmatched";
  if (!capabilities.has(DEVICE_COMMANDS_CAPABILITY)) {
    throw new HttpError(404, sourceText("error.team.routeNotFound"));
  }
  if (!deviceCommands) throw new HttpError(503, sourceText("error.team.requestFailed"));
  if (member.role === "member") throw new HttpError(403, sourceText("error.team.adminRequired"));

  try {
    if (method === "GET" && route === DEVICE_COMMAND_ROUTES.info) {
      return json(200, await runCauseEffect(deviceCommands.info()));
    }
    if (method === "GET" && route === DEVICE_COMMAND_ROUTES.permissions) {
      const agentId = queryAgentId(url.searchParams.get("agentId"));
      return json(200, await runCauseEffect(deviceCommands.getPermission(agentId)));
    }
    if (method === "POST" && route === DEVICE_COMMAND_ROUTES.updatePermissions) {
      const body = await readJson(request);
      const commandsEnabled = booleanField(body, "commandsEnabled");
      const computerUseEnabled = booleanField(body, "computerUseEnabled");
      return json(
        200,
        await runCauseEffect(
          deviceCommands.updatePermission({
            agentId: stringField(body, "agentId"),
            commandsEnabled,
            computerUseEnabled,
            allowedExecutables: stringArray(body, "allowedExecutables", 64, 128),
            allowedDirectories: stringArray(body, "allowedDirectories", 32, 4_096),
          }),
        ),
      );
    }
    if (method === "POST" && route === DEVICE_COMMAND_ROUTES.run) {
      const body = await readJson(request);
      return json(
        200,
        await runCauseEffect(
          deviceCommands.run({
            agentId: stringField(body, "agentId"),
            executable: stringField(body, "executable", false, 128),
            args: stringArray(body, "args", 64, 4_096),
            workingDirectory: stringField(body, "workingDirectory", false, 4_096),
          }),
        ),
      );
    }
    if (method === "GET" && route === DEVICE_COMMAND_ROUTES.computerUseTools) {
      const agentId = queryAgentId(url.searchParams.get("agentId"));
      return json(200, { tools: await runCauseEffect(deviceCommands.listComputerUseTools(agentId)) });
    }
    if (method === "POST" && route === DEVICE_COMMAND_ROUTES.computerUseCall) {
      const body = await readJson(request);
      const args = body.arguments;
      if (!isDynamicRecord(args)) throw new HttpError(400, sourceText("error.team.requestFailed"));
      return json(
        200,
        await runCauseEffect(
          deviceCommands.callComputerUse({
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

function queryAgentId(value: string | null): string {
  if (value === null) throw new HttpError(400, sourceText("error.team.requestFailed"));
  const decoded = pathIdentifier(value, "agentId");
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(decoded)) throw new HttpError(400, sourceText("error.team.requestFailed"));
  return decoded;
}

function booleanField(value: DynamicRecord, field: string): boolean {
  if (!isBoolean(value[field])) throw new HttpError(400, sourceText("error.team.requestFailed"));
  return value[field];
}

function deviceCommandHttpError(error: RemoteDeviceCommandHostError): HttpError {
  const status =
    error.reason === "permission"
      ? 403
      : error.reason === "invalid" || error.reason === "review"
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
        ? sourceText("error.computerUse.remoteCommandBlocked")
        : error.reason === "invalid"
          ? sourceText("error.computerUse.remoteCommandInvalid")
          : sourceText("error.computerUse.remoteOperationUnavailable");
  return new HttpError(status, message);
}
