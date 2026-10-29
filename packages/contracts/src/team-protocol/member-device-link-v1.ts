// Additive one-time links that create a separate device session for an existing team member.
// The target member is derived from the opaque, short-lived token on the host; it is never supplied
// by the joining client. The token is a bearer secret and must only be sent after the host identity
// has been verified.

import { isDynamicRecord, isString } from "../runtime-values";
import { TEAM_API_ROUTES } from "../team-api-routes";
import { adminRoute, empty, fields, identifier, type OptionalRouteCodec, oneOf, string } from "./admin-wire";

export const TEAM_MEMBER_DEVICE_LINK_CAPABILITY = "member-device-link-v1";

export const TEAM_MEMBER_DEVICE_LINK_ROUTES = {
  create: TEAM_API_ROUTES.team.memberDeviceLinks,
  redeem: TEAM_API_ROUTES.join.memberDevice,
} as const;

const token = (value: unknown) => {
  if (!isString(value) || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Invalid member device link.");
  return value;
};

const member = (value: unknown) => {
  if (!isDynamicRecord(value) || !isString(value.id) || !isString(value.role)) {
    throw new Error("Invalid member device link response.");
  }
  return { id: identifier(value.id), role: oneOf("owner", "admin", "member")(value.role) };
};

const joined = fields({ member, sessionToken: string(128), sessionExpiresAt: string(64) });

export interface CreatedMemberDeviceLink {
  token: string;
  expiresAt: string;
}

/** Decodes the host's one-time link response for native callers before they expose the secret. */
export function decodeCreatedMemberDeviceLink(value: unknown): CreatedMemberDeviceLink {
  if (!isDynamicRecord(value) || !isString(value.expiresAt) || value.expiresAt.length > 64) {
    throw new Error("Invalid member device link response.");
  }
  return { token: token(value.token), expiresAt: value.expiresAt };
}

export const TEAM_MEMBER_DEVICE_LINK_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [TEAM_MEMBER_DEVICE_LINK_ROUTES.create, adminRoute(empty, fields({ token, expiresAt: string(64) }))],
  [TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem, adminRoute(fields({ token }), joined)],
]);
