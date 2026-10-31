import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  SERVER_MIGRATION_CAPABILITY,
  SERVER_MIGRATION_CHUNK_BYTES_LIMIT,
  SERVER_MIGRATION_CHUNK_SHA256_HEADER,
  SERVER_MIGRATION_JSON_BYTES_LIMIT,
  SERVER_MIGRATION_ROUTES,
} from "@openbot/contracts/team-protocol/server-migration-v1";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { readBodyWithin } from "../http-body";
import { ServerMigrationTransferFailure } from "../server-migration-transfer";
import type { TeamApiServerMigration } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readBinary, stringField } from "./request-helpers";

const ROUTE_METHODS = new Map<string, string>([
  [SERVER_MIGRATION_ROUTES.begin, "POST"],
  [SERVER_MIGRATION_ROUTES.status, "GET"],
  [SERVER_MIGRATION_ROUTES.chunk, "PUT"],
  [SERVER_MIGRATION_ROUTES.pause, "POST"],
  [SERVER_MIGRATION_ROUTES.resume, "POST"],
  [SERVER_MIGRATION_ROUTES.finalize, "POST"],
]);

/** The owner-only destination API. Finalization activates only through a host-owned callback. */
export async function routeServerMigration(
  context: TeamApiRequestContext,
  migration: TeamApiServerMigration | undefined,
): Promise<RouteOutcome> {
  const expectedMethod = ROUTE_METHODS.get(context.url.pathname);
  if (!expectedMethod || context.method !== expectedMethod) return "unmatched";
  if (
    migration?.serverMode !== true ||
    process.platform !== "linux" ||
    !context.capabilities.has(SERVER_MIGRATION_CAPABILITY)
  ) {
    throw new HttpError(404, sourceText("error.team.routeNotFound"));
  }
  if (context.member.role !== "owner") throw new HttpError(403, sourceText("error.team.ownerRequired"));

  const memberId = context.member.id;
  const { url, request, json } = context;
  if (url.pathname === SERVER_MIGRATION_ROUTES.begin) {
    assertNoQuery(url);
    const body = await readMigrationJson(context);
    const status = await runTransfer(
      migration.transfer.begin({
        memberId,
        requestId: stringField(body, "requestId"),
        manifest: body.manifest,
      }),
    );
    return json(200, status);
  }

  if (url.pathname === SERVER_MIGRATION_ROUTES.status) {
    const transferId = oneQuery(url, "transferId", 128);
    const status = await runTransfer(migration.transfer.status(memberId, transferId));
    return json(200, status);
  }

  if (url.pathname === SERVER_MIGRATION_ROUTES.chunk) {
    const query = exactQuery(url, ["transferId", "path", "offset"]);
    const transferId = query.transferId;
    const path = query.path;
    const offset = Number(query.offset);
    if (
      !transferId ||
      transferId.length > 128 ||
      !path ||
      path.length > 4_096 ||
      !/^(0|[1-9]\d{0,15})$/u.test(query.offset ?? "") ||
      !Number.isSafeInteger(offset)
    ) {
      throw invalidRequest();
    }
    const contentType = request.headers["content-type"];
    const mediaType = (Array.isArray(contentType) ? null : contentType)?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/octet-stream") throw invalidRequest();
    const checksum = request.headers[SERVER_MIGRATION_CHUNK_SHA256_HEADER.toLowerCase()];
    if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/u.test(checksum)) throw invalidRequest();
    const bytes = await readBinary(request, SERVER_MIGRATION_CHUNK_BYTES_LIMIT).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 413) throw requestTooLarge();
      throw error;
    });
    const status = await runTransfer(
      migration.transfer.writeChunk({ memberId, transferId, path, offset, bytes, sha256: checksum }),
    );
    return json(200, status);
  }

  if (url.pathname === SERVER_MIGRATION_ROUTES.pause || url.pathname === SERVER_MIGRATION_ROUTES.resume) {
    const body = await readMigrationJson(context);
    const transferId = stringField(body, "transferId");
    const status = await runTransfer(
      url.pathname === SERVER_MIGRATION_ROUTES.pause
        ? migration.transfer.cancel(memberId, transferId)
        : migration.transfer.resume(memberId, transferId),
    );
    return json(200, status);
  }

  if (url.pathname === SERVER_MIGRATION_ROUTES.finalize) {
    const body = await readMigrationJson(context);
    const transferId = stringField(body, "transferId");
    const verified = await runTransfer(migration.transfer.finalize(memberId, transferId));
    // The callback is host-owned and must be idempotent by transferId. A failed activation leaves
    // the verified staging snapshot available for a retry. Its private path never reaches `json`.
    await runTransfer(
      migration.transfer.withVerifiedSnapshot(memberId, transferId, async (snapshotPath, manifest) => {
        await migration.activate({ memberId, transferId, snapshotPath, manifest });
      }),
    );
    return json(200, verified);
  }

  return "unmatched";
}

async function readMigrationJson(context: TeamApiRequestContext): Promise<DynamicRecord> {
  const contentType = context.request.headers["content-type"];
  const mediaType = (Array.isArray(contentType) ? null : contentType)?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw invalidRequest();
  const bytes = await readBodyWithin(context.request, SERVER_MIGRATION_JSON_BYTES_LIMIT);
  if (bytes === null) throw requestTooLarge();
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    const codec = teamSideRouteCodec(context.url.pathname);
    if (!codec) throw new Error("The migration request codec is unavailable.");
    const decoded = codec.request(context.url.pathname, value);
    if (!isDynamicRecord(decoded)) throw new Error("The migration request is invalid.");
    return decoded;
  } catch {
    throw invalidRequest();
  }
}

function exactQuery(url: URL, expected: string[]): Record<string, string> {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== expected.length ||
    entries.some(([key]) => !expected.includes(key)) ||
    url.search.length > 8_192
  ) {
    throw invalidRequest();
  }
  const values: Record<string, string> = {};
  for (const key of expected) {
    const matches = url.searchParams.getAll(key);
    if (matches.length !== 1) throw invalidRequest();
    values[key] = matches[0] ?? "";
  }
  return values;
}

function oneQuery(url: URL, key: string, maxLength: number): string {
  const values = exactQuery(url, [key]);
  const value = values[key];
  if (!value || value.length > maxLength) throw invalidRequest();
  return value;
}

function assertNoQuery(url: URL): void {
  if (url.search) throw invalidRequest();
}

async function runTransfer<T>(effect: Effect.Effect<T, ServerMigrationTransferFailure>): Promise<T> {
  try {
    return await Effect.runPromise(effect);
  } catch (error) {
    if (!(error instanceof ServerMigrationTransferFailure)) throw error;
    if (error.code === "storage_error") throw error;
    const status =
      error.code === "owner_required"
        ? 403
        : error.code === "capacity_exceeded"
          ? 413
          : error.code === "invalid_manifest" || error.code === "invalid_transfer" || error.code === "invalid_chunk"
            ? 400
            : 409;
    const message =
      error.code === "capacity_exceeded"
        ? sourceText("error.team.requestTooLarge")
        : sourceText("error.team.requestFailed");
    throw new HttpError(status, message);
  }
}

function invalidRequest(): HttpError {
  return new HttpError(400, sourceText("error.team.requestFailed"));
}

function requestTooLarge(): HttpError {
  return new HttpError(413, sourceText("error.team.requestTooLarge"));
}
