// Additive, owner-only transfer protocol for allowlisted server migration snapshots.
// Snapshot paths are relative manifest entries. The destination host's filesystem paths never cross this wire.

import { isString } from "../runtime-values";
import {
  type AdminDecoder,
  adminRoute,
  count,
  empty,
  fields,
  identifier,
  list,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";

export const SERVER_MIGRATION_CAPABILITY = "server-migration-v1";
/** A destination with this capability can preserve chat references to files already missing on the source. */
export const SERVER_MIGRATION_MISSING_ATTACHMENTS_CAPABILITY = "server-migration-missing-attachments-v1";

export const SERVER_MIGRATION_ROUTES = {
  begin: "/v1/server-migration/transfers/begin",
  status: "/v1/server-migration/transfers/status",
  chunk: "/v1/server-migration/transfers/chunk",
  pause: "/v1/server-migration/transfers/pause",
  resume: "/v1/server-migration/transfers/resume",
  finalize: "/v1/server-migration/transfers/finalize",
} as const;

export const SERVER_MIGRATION_JSON_BYTES_LIMIT = 8 * 1024 * 1024 + 16 * 1024;
export const SERVER_MIGRATION_CHUNK_BYTES_LIMIT = 4 * 1024 * 1024;
export const SERVER_MIGRATION_CHUNK_SHA256_HEADER = "OpenBot-Migration-Chunk-SHA256";

const path: AdminDecoder = (value) => {
  if (!isString(value) || value.length > 4_096 || value.includes("\\") || value.includes("\0")) {
    throw new Error("Invalid migration manifest path.");
  }
  const segments = value.split("/");
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid migration manifest path.");
  }
  return value;
};
const portableAttachmentPath: AdminDecoder = (value) => {
  const prefix = "openbot-migration-path://";
  if (!isString(value) || value.length > 4_096 || !value.startsWith(prefix)) {
    throw new Error("Invalid portable attachment path.");
  }
  const relative = value.slice(prefix.length);
  const segments = relative.split("/");
  if (
    segments.length < 2 ||
    !["Agents", "Bots", "Shared"].includes(segments[0] ?? "") ||
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"),
    )
  ) {
    throw new Error("Invalid portable attachment path.");
  }
  return value;
};
const sha256: AdminDecoder = (value) => {
  if (!isString(value) || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid migration checksum.");
  return value;
};
const version: AdminDecoder = (value) => {
  if (value !== 2) throw new Error("Invalid migration snapshot version.");
  return 2;
};
const manifestFile = fields({ path, bytes: count, sha256 });
const manifest = fields(
  {
    version,
    createdAt: string(128),
    directories: list(path, 50_000),
    files: list(manifestFile, 50_000),
    totalBytes: count,
  },
  { missingAttachmentPaths: list(portableAttachmentPath, 50_000) },
);
const statusFile = fields({
  path,
  bytes: count,
  receivedBytes: count,
  complete: (value) => {
    if (typeof value !== "boolean") throw new Error("Invalid migration completion flag.");
    return value;
  },
});
const status = fields({
  transferId: identifier,
  state: oneOf("receiving", "paused", "verified"),
  totalBytes: count,
  receivedBytes: count,
  files: list(statusFile, 50_000),
});
const verified = fields({ transferId: identifier, manifest });
const transferId = fields({ transferId: identifier });

export const SERVER_MIGRATION_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [SERVER_MIGRATION_ROUTES.begin, adminRoute(fields({ requestId: identifier, manifest }), status)],
  [SERVER_MIGRATION_ROUTES.status, adminRoute(empty, status)],
  [SERVER_MIGRATION_ROUTES.chunk, adminRoute(empty, status)],
  [SERVER_MIGRATION_ROUTES.pause, adminRoute(transferId, status)],
  [SERVER_MIGRATION_ROUTES.resume, adminRoute(transferId, status)],
  [SERVER_MIGRATION_ROUTES.finalize, adminRoute(transferId, verified)],
]);
