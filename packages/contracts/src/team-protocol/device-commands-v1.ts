// Optional, target-enforced remote device command API. Existing Team protocol adapters remain frozen.

import { isDynamicRecord } from "../runtime-values";
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
import type { TeamProtocolV2Json } from "./v2";
import { decodeTeamProtocolV2Json } from "./v2";

export const DEVICE_COMMANDS_CAPABILITY = "device-commands-v1";

export const DEVICE_COMMAND_ROUTES = {
  info: "/v1/device-commands/target",
  permissions: "/v1/device-commands/permissions",
  updatePermissions: "/v1/device-commands/permissions/update",
  run: "/v1/device-commands/run",
  computerUseTools: "/v1/device-commands/computer-use/tools",
  computerUseCall: "/v1/device-commands/computer-use/call",
} as const;

const executable = string(128);
const directory = string(4096);
const args = list(string(4096), 64);
const jsonObject = (value: unknown): TeamProtocolV2Json => {
  const decoded = decodeTeamProtocolV2Json(value);
  if (!isDynamicRecord(decoded)) {
    throw new Error("Invalid device command arguments.");
  }
  return decoded;
};
const computerUseContentItem = (value: unknown): TeamProtocolV2Json => {
  if (!isDynamicRecord(value)) {
    throw new Error("Invalid Computer Use content item.");
  }
  if (value.type === "inputText") return fields({ type: oneOf("inputText"), text: string(65_536) })(value);
  if (value.type === "inputImage") return fields({ type: oneOf("inputImage"), imageUrl: string(5_600_000) })(value);
  throw new Error("Invalid Computer Use content item.");
};
const permission = fields({
  agentId: identifier,
  commandsEnabled: boolean,
  computerUseEnabled: boolean,
  allowedExecutables: list(executable, 64),
  allowedDirectories: list(directory, 32),
});
const permissionResponse = fields({
  agentId: identifier,
  commandsEnabled: boolean,
  computerUseEnabled: boolean,
  allowedExecutables: list(executable, 64),
  allowedDirectories: list(directory, 32),
  updatedAt: nullable(string(64)),
});

export const DEVICE_COMMAND_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    DEVICE_COMMAND_ROUTES.info,
    adminRoute(
      fields({}),
      fields({
        serverId: identifier,
        name: string(128),
        platform: oneOf("windows", "linux"),
        computerUseAvailable: boolean,
      }),
    ),
  ],
  [DEVICE_COMMAND_ROUTES.permissions, adminRoute(fields({}), permissionResponse)],
  [DEVICE_COMMAND_ROUTES.updatePermissions, adminRoute(permission, permissionResponse)],
  [
    DEVICE_COMMAND_ROUTES.run,
    adminRoute(
      fields({ agentId: identifier, executable, args, workingDirectory: directory }),
      fields({
        exitCode: nullable(count),
        stdout: string(65_536),
        stderr: string(65_536),
        durationMs: count,
        timedOut: boolean,
      }),
    ),
  ],
  [
    DEVICE_COMMAND_ROUTES.computerUseTools,
    adminRoute(fields({}), fields({ tools: list(fields({ name: string(128), description: string(2048) }), 128) })),
  ],
  [
    DEVICE_COMMAND_ROUTES.computerUseCall,
    adminRoute(
      fields({ agentId: identifier, tool: string(128), arguments: jsonObject }),
      fields({ success: boolean, contentItems: list(computerUseContentItem, 8) }),
    ),
  ],
]);
