import { createHash } from "node:crypto";
import { SERVER_MIGRATION_ROUTES } from "@openbot/contracts/team-protocol/server-migration-v1";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createLocalServerMigrationPeer } from "./server-migration-local-peer";
import type { ServerMigrationSnapshotManifest } from "./server-migration-snapshot";
import { decodeServerMigrationTransferStatus, decodeServerMigrationVerified } from "./server-migration-wire";
import type { TeamApiServerMigration } from "./team-api/dependencies";

const manifest: ServerMigrationSnapshotManifest = {
  version: 2,
  createdAt: "2026-11-01T00:00:00.000Z",
  directories: ["user-data", "home", "home/OpenBot"],
  files: [{ path: "user-data/openbot.db", bytes: 4, sha256: "0".repeat(64) }],
  missingAttachmentPaths: [],
  totalBytes: 4,
};

function createFixture() {
  const calls: Array<{ name: string; detail?: unknown }> = [];
  const status = {
    transferId: "transfer-1",
    state: "receiving" as const,
    totalBytes: 4,
    receivedBytes: 0,
    files: [{ path: "user-data/openbot.db", bytes: 4, receivedBytes: 0, complete: false }],
  };
  const activated: Array<{ memberId: string; transferId: string; snapshotPath: string }> = [];
  const migration: TeamApiServerMigration = {
    serverMode: true,
    transfer: {
      begin: (input) => {
        calls.push({ name: "begin", detail: input });
        return Effect.succeed(status);
      },
      status: (memberId, transferId) => {
        calls.push({ name: "status", detail: { memberId, transferId } });
        return Effect.succeed(status);
      },
      writeChunk: (input) => {
        calls.push({ name: "chunk", detail: input });
        return Effect.succeed(status);
      },
      cancel: (memberId, transferId) => {
        calls.push({ name: "cancel", detail: { memberId, transferId } });
        return Effect.succeed(status);
      },
      resume: (memberId, transferId) => {
        calls.push({ name: "resume", detail: { memberId, transferId } });
        return Effect.succeed(status);
      },
      finalize: (memberId, transferId) => {
        calls.push({ name: "finalize", detail: { memberId, transferId } });
        return Effect.succeed({ transferId, manifest });
      },
      withVerifiedSnapshot: (memberId, transferId, consume) =>
        Effect.promise(async () => {
          calls.push({ name: "verified", detail: { memberId, transferId } });
          await consume("/staging/snapshot-transfer-1", manifest);
          return manifest;
        }),
    },
    activate: async (input) => {
      activated.push({ memberId: input.memberId, transferId: input.transferId, snapshotPath: input.snapshotPath });
    },
  };
  const peer = createLocalServerMigrationPeer({
    serverId: "local",
    serverName: "Local",
    migration,
    memberId: "owner-1",
    members: () => [
      {
        id: "owner-1",
        username: "owner",
        email: "owner@example.com",
        name: "Owner",
        role: "owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        disabled: false,
      },
    ],
  });
  return { calls, activated, peer };
}

describe("createLocalServerMigrationPeer", () => {
  it("mirrors the migration routes into the in-process transfer service", async () => {
    const { calls, peer } = createFixture();

    const begun = await peer.request(SERVER_MIGRATION_ROUTES.begin, decodeServerMigrationTransferStatus, {
      method: "POST",
      body: { requestId: "job-1", manifest },
    });
    expect(begun.transferId).toBe("transfer-1");

    await peer.request(`${SERVER_MIGRATION_ROUTES.status}?transferId=transfer-1`, decodeServerMigrationTransferStatus, {
      method: "GET",
    });
    await peer.request(SERVER_MIGRATION_ROUTES.pause, decodeServerMigrationTransferStatus, {
      method: "POST",
      body: { transferId: "transfer-1" },
    });
    await peer.request(SERVER_MIGRATION_ROUTES.resume, decodeServerMigrationTransferStatus, {
      method: "POST",
      body: { transferId: "transfer-1" },
    });

    expect(calls.map((call) => call.name)).toEqual(["begin", "status", "cancel", "resume"]);
    expect(calls[0]?.detail).toMatchObject({ memberId: "owner-1", requestId: "job-1", manifest });
    expect(calls[1]?.detail).toEqual({ memberId: "owner-1", transferId: "transfer-1" });
  });

  it("finalizes through the host-owned activation callback", async () => {
    const { activated, peer } = createFixture();

    const verified = await peer.request(SERVER_MIGRATION_ROUTES.finalize, decodeServerMigrationVerified, {
      method: "POST",
      body: { transferId: "transfer-1" },
    });

    expect(verified).toEqual({ transferId: "transfer-1" });
    expect(activated).toEqual([
      { memberId: "owner-1", transferId: "transfer-1", snapshotPath: "/staging/snapshot-transfer-1" },
    ]);
  });

  it("hashes each chunk exactly as the HTTP route does before it writes", async () => {
    const { calls, peer } = createFixture();
    const bytes = new Uint8Array(new ArrayBuffer(4));

    await peer.writeChunk({ transferId: "transfer-1", path: "user-data/openbot.db", offset: 0, bytes });

    const chunk = calls.find((call) => call.name === "chunk");
    expect(chunk?.detail).toMatchObject({
      memberId: "owner-1",
      transferId: "transfer-1",
      path: "user-data/openbot.db",
      offset: 0,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("refuses a path the Team API never serves", async () => {
    const { peer } = createFixture();
    await expect(peer.request("/v1/server-migration/unknown", decodeServerMigrationVerified)).rejects.toThrow();
  });
});
