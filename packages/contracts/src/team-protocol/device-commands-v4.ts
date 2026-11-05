// Cloud-reviewed device-wide command execution. V3 stays frozen with its target-local rule set.
import {
  adminRoute,
  boolean,
  count,
  fields,
  identifier,
  list,
  nullable,
  type OptionalRouteCodec,
  string,
} from "./admin-wire";

export const DEVICE_COMMANDS_V4_CAPABILITY = "device-commands-v4";

export const DEVICE_COMMANDS_V4_ROUTES = {
  run: "/v4/device-commands/run",
} as const;

export const DEVICE_COMMANDS_V4_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    DEVICE_COMMANDS_V4_ROUTES.run,
    adminRoute(
      fields({
        agentId: identifier,
        executable: string(128),
        args: list(string(4_096), 64),
        workingDirectory: string(4_096),
        safetyReviewed: boolean,
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
