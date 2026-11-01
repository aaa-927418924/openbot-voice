// The destination peer for this computer's own local server: the source and the destination run in
// one process, so the snapshot travels straight into the transfer service that the Team API routes
// drive instead of over a socket. Each branch mirrors one route of `route-server-migration`,
// including finalize's host-owned activation callback. Ownership is the local team store's owner,
// which the destination rechecks on every transfer call.

import { createHash } from "node:crypto";
import type { TeamMemberSummary } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { SERVER_MIGRATION_ROUTES } from "@openbot/contracts/team-protocol/server-migration-v1";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { RemoteRequestInit } from "./remote-server-client";
import type { ServerMigrationDestinationPeer } from "./server-migration-source";
import type { TeamApiServerMigration } from "./team-api/dependencies";

export interface LocalServerMigrationPeerOptions {
  /** The server ID and name the renderer shows for this computer's own local server. */
  readonly serverId: string;
  readonly serverName: string;
  /** The migration service of this process's local team server. */
  readonly migration: TeamApiServerMigration;
  /** The owner membership of this local host. The destination rechecks it per call. */
  readonly memberId: string;
  /** The members of this local host's team directory. */
  readonly members: () => readonly TeamMemberSummary[];
}

export function createLocalServerMigrationPeer(
  options: LocalServerMigrationPeerOptions,
): ServerMigrationDestinationPeer {
  const { migration, memberId } = options;
  const transfer = migration.transfer;

  return {
    serverId: options.serverId,
    serverName: options.serverName,
    supportsMissingAttachments: true,
    members: async () => [...options.members()],
    request: async <T>(path: string, decoder: (value: unknown) => T, init?: RemoteRequestInit): Promise<T> => {
      const body = isDynamicRecord(init?.body) ? init.body : {};
      if (path === SERVER_MIGRATION_ROUTES.begin) {
        return decoder(
          await Effect.runPromise(
            transfer.begin({ memberId, requestId: stringBody(body, "requestId"), manifest: body.manifest }),
          ),
        );
      }
      if (path.startsWith(`${SERVER_MIGRATION_ROUTES.status}?`)) {
        return decoder(await Effect.runPromise(transfer.status(memberId, transferIdFromQuery(path))));
      }
      if (path === SERVER_MIGRATION_ROUTES.pause) {
        return decoder(await Effect.runPromise(transfer.cancel(memberId, stringBody(body, "transferId"))));
      }
      if (path === SERVER_MIGRATION_ROUTES.resume) {
        return decoder(await Effect.runPromise(transfer.resume(memberId, stringBody(body, "transferId"))));
      }
      if (path === SERVER_MIGRATION_ROUTES.finalize) {
        const transferId = stringBody(body, "transferId");
        const verified = await Effect.runPromise(transfer.finalize(memberId, transferId));
        // Like the route: activation is the host-owned callback and idempotent by transferId. A
        // failed activation leaves the verified staging snapshot available for a retry.
        await Effect.runPromise(
          transfer.withVerifiedSnapshot(memberId, transferId, async (snapshotPath, manifest) => {
            await migration.activate({ memberId, transferId, snapshotPath, manifest });
          }),
        );
        return decoder(verified);
      }
      throw new Error(sourceText("error.host.migrationUnsupported"));
    },
    writeChunk: async (input) =>
      Effect.runPromise(
        transfer.writeChunk({
          memberId,
          transferId: input.transferId,
          path: input.path,
          offset: input.offset,
          bytes: input.bytes,
          // The HTTP route checks the bytes' hash before it writes; the same check runs here.
          sha256: createHash("sha256").update(input.bytes).digest("hex"),
        }),
      ),
  };
}

function stringBody(body: DynamicRecord, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value) throw new Error(sourceText("error.host.migrationTransferFailed"));
  return value;
}

function transferIdFromQuery(path: string): string {
  const transferId = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("transferId");
  if (!transferId) throw new Error(sourceText("error.host.migrationTransferFailed"));
  return transferId;
}
