// Device-wide, target-enforced command permissions. The v1 per-agent contract remains unchanged.

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

export const DEVICE_COMMANDS_V2_CAPABILITY = "device-commands-v2";

export const DEVICE_COMMANDS_V2_ROUTES = {
  info: "/v2/device-commands/target",
  policy: "/v2/device-commands/policy",
  updatePolicy: "/v2/device-commands/policy/update",
  run: "/v2/device-commands/run",
  computerUseTools: "/v2/device-commands/computer-use/tools",
  computerUseCall: "/v2/device-commands/computer-use/call",
} as const;

const jsonObject = (value: unknown): TeamProtocolV2Json => {
  const decoded = decodeTeamProtocolV2Json(value);
  if (!isDynamicRecord(decoded)) throw new Error("Invalid device command arguments.");
  return decoded;
};
const computerUseContentItem = (value: unknown): TeamProtocolV2Json => {
  if (!isDynamicRecord(value)) throw new Error("Invalid Computer Use content item.");
  if (value.type === "inputText") return fields({ type: oneOf("inputText"), text: string(65_536) })(value);
  if (value.type === "inputImage") return fields({ type: oneOf("inputImage"), imageUrl: string(5_600_000) })(value);
  throw new Error("Invalid Computer Use content item.");
};

const policy = fields({ commandsEnabled: boolean, computerUseEnabled: boolean });
const policyResponse = fields({
  commandsEnabled: boolean,
  computerUseEnabled: boolean,
  updatedAt: nullable(string(64)),
});

export const DEVICE_COMMANDS_V2_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    DEVICE_COMMANDS_V2_ROUTES.info,
    adminRoute(
      fields({}),
      fields(
        {
          serverId: identifier,
          name: string(128),
          platform: oneOf("windows", "linux"),
          computerUseAvailable: boolean,
          autoReviewAvailable: boolean,
        },
        { deviceName: string(128) },
      ),
    ),
  ],
  [DEVICE_COMMANDS_V2_ROUTES.policy, adminRoute(fields({}), policyResponse)],
  [DEVICE_COMMANDS_V2_ROUTES.updatePolicy, adminRoute(policy, policyResponse)],
  [
    DEVICE_COMMANDS_V2_ROUTES.run,
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
  [
    DEVICE_COMMANDS_V2_ROUTES.computerUseTools,
    adminRoute(fields({}), fields({ tools: list(fields({ name: string(128), description: string(2_048) }), 128) })),
  ],
  [
    DEVICE_COMMANDS_V2_ROUTES.computerUseCall,
    adminRoute(
      fields({ agentId: identifier, tool: string(128), arguments: jsonObject }),
      fields({ success: boolean, contentItems: list(computerUseContentItem, 8) }),
    ),
  ],
]);
