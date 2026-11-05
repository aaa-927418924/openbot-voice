// Device-wide command permissions with target-local command review. Version 2 remains frozen
// because released clients use Codex AutoReview for its command route.
import {
  adminRoute,
  boolean,
  count,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";

export const DEVICE_COMMANDS_V3_CAPABILITY = "device-commands-v3";

export const DEVICE_COMMANDS_V3_ROUTES = {
  info: "/v3/device-commands/target",
  run: "/v3/device-commands/run",
} as const;

export const DEVICE_COMMANDS_V3_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    DEVICE_COMMANDS_V3_ROUTES.info,
    adminRoute(
      fields({}),
      fields({
        serverId: identifier,
        name: string(128),
        deviceName: string(128),
        platform: oneOf("windows", "linux"),
        computerUseAvailable: boolean,
        localReviewAvailable: boolean,
      }),
    ),
  ],
  [
    DEVICE_COMMANDS_V3_ROUTES.run,
    adminRoute(
      fields({
        agentId: identifier,
        executable: string(128),
        args: list(string(4_096), 64),
        workingDirectory: string(4_096),
      }),
      fields({
        exitCode: nullable(count),
        stdout: string(65_536),
        stderr: string(65_536),
        durationMs: count,
        timedOut: boolean,
      }),
    ),
  ],
]);
