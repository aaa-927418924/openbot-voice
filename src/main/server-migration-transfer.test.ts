import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerMigrationSnapshotManifest } from "./server-migration-snapshot";
import { ServerMigrationTransferFailure, ServerMigrationTransferService } from "./server-migration-transfer";

const OWNER = "owner-member";
const USER_DB = Buffer.from("user-database-bytes");
const AGENT_DB = Buffer.from("agent-database-bytes");
const CHUNK_BYTES = 4;

describe("server migration transfer", () => {
  let root: string;
  let stagingRoot: string;
  let service: ServerMigrationTransferService;
  const ownerCheck = (memberId: string) => {
    if (memberId !== OWNER) throw new Error("not host owner");
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-server-migration-transfer-"));
    stagingRoot = join(root, "staging");
    service = createService(stagingRoot, ownerCheck);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resumes bounded chunks, accepts retries, verifies once complete, and keeps filesystem paths private", async () => {
    const manifest = {
      ...makeManifest(),
      missingAttachmentPaths: ["openbot-migration-path://Shared/Transfers/generated/missing-id/image.png"],
    };
    const requestId = randomUUID();
    const started = await run(service.begin({ memberId: OWNER, requestId, manifest }));
    const retriedBegin = await run(service.begin({ memberId: OWNER, requestId, manifest }));
    expect(retriedBegin.transferId).toBe(started.transferId);

    const first = USER_DB.subarray(0, CHUNK_BYTES);
    const firstChunk = {
      memberId: OWNER,
      transferId: started.transferId,
      path: "user-data/openbot.db",
      offset: 0,
      bytes: first,
      sha256: hash(first),
    };
    const progressAfterFirstWrite = await run(service.writeChunk(firstChunk));
    await run(service.writeChunk(firstChunk));
    expect((await run(service.status(OWNER, started.transferId))).receivedBytes).toBe(
      progressAfterFirstWrite.receivedBytes,
    );

    const paused = await run(service.cancel(OWNER, started.transferId));
    expect(paused.state).toBe("paused");
    service = createService(stagingRoot, ownerCheck);
    expect((await run(service.status(OWNER, started.transferId))).receivedBytes).toBe(
      progressAfterFirstWrite.receivedBytes,
    );
    await expect(run(service.finalize(OWNER, started.transferId))).rejects.toMatchObject({ code: "transfer_conflict" });
    await expect(
      run(
        service.writeChunk({
          ...firstChunk,
          offset: CHUNK_BYTES,
          bytes: USER_DB.subarray(CHUNK_BYTES, CHUNK_BYTES * 2),
          sha256: hash(USER_DB.subarray(CHUNK_BYTES, CHUNK_BYTES * 2)),
        }),
      ),
    ).rejects.toBeInstanceOf(ServerMigrationTransferFailure);
    expect((await readdir(stagingRoot)).includes(started.transferId)).toBe(true);

    await run(service.resume(OWNER, started.transferId));
    await writeRemaining(service, started.transferId, "user-data/openbot.db", USER_DB, CHUNK_BYTES);
    await writeRemaining(service, started.transferId, "home/OpenBot/Shared/Data/agent-data.db", AGENT_DB, 0);
    const finalized = await run(service.finalize(OWNER, started.transferId));
    const repeatedFinalize = await run(service.finalize(OWNER, started.transferId));
    expect(repeatedFinalize).toEqual(finalized);
    expect(finalized.manifest).toEqual(manifest);
    expect("snapshotDirectory" in finalized).toBe(false);
    expect(JSON.stringify(finalized)).not.toContain(root);

    let consumedPath = "";
    const consumedManifest = await run(
      service.withVerifiedSnapshot(OWNER, started.transferId, async (snapshotPath, verifiedManifest) => {
        consumedPath = snapshotPath;
        expect(await readFile(join(snapshotPath, "user-data/openbot.db"))).toEqual(USER_DB);
        expect(verifiedManifest).toEqual(finalized.manifest);
      }),
    );
    expect(consumedPath.startsWith(stagingRoot)).toBe(true);
    expect(consumedManifest).toEqual(finalized.manifest);

    await run(service.discardVerified(OWNER, started.transferId));
    await expect(readdir(join(stagingRoot, started.transferId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans only unpublished begin state left by a crash", async () => {
    const abandonedDirectory = join(stagingRoot, `.begin-${randomUUID()}`);
    await mkdir(abandonedDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(abandonedDirectory, "partial"), "not yet accepted");

    const transfer = await run(service.begin({ memberId: OWNER, requestId: randomUUID(), manifest: makeManifest() }));

    expect(await readdir(stagingRoot)).toEqual([transfer.transferId]);
  });

  it("requires the authenticated owner for every operation and binds retries to that owner", async () => {
    const requestId = randomUUID();
    await expect(
      run(service.begin({ memberId: "other-member", requestId, manifest: makeManifest() })),
    ).rejects.toMatchObject({
      code: "owner_required",
    });
    await expect(readdir(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const transfer = await run(service.begin({ memberId: OWNER, requestId, manifest: makeManifest() }));
    await expect(run(service.status("other-member", transfer.transferId))).rejects.toMatchObject({
      code: "owner_required",
    });
    const firstChunk = USER_DB.subarray(0, CHUNK_BYTES);
    await expect(
      run(
        service.writeChunk({
          memberId: "other-member",
          transferId: transfer.transferId,
          path: "user-data/openbot.db",
          offset: 0,
          bytes: firstChunk,
          sha256: hash(firstChunk),
        }),
      ),
    ).rejects.toMatchObject({ code: "owner_required" });
    await expect(run(service.finalize("other-member", transfer.transferId))).rejects.toMatchObject({
      code: "owner_required",
    });
    await expect(
      run(service.withVerifiedSnapshot("other-member", transfer.transferId, async () => undefined)),
    ).rejects.toMatchObject({ code: "owner_required" });
  });

  it("rejects traversal, duplicate and non-allowlisted manifest paths before creating a transfer", async () => {
    const base = makeManifest();
    const traversal = {
      ...base,
      files: [...base.files, { path: "user-data/../../outside", bytes: 1, sha256: hash(Buffer.from("x")) }],
      totalBytes: base.totalBytes + 1,
    };
    const firstFile = base.files.at(0);
    if (!firstFile) throw new Error("The fixture must include its required database files.");
    const duplicate = {
      ...base,
      files: [...base.files, firstFile],
      totalBytes: base.totalBytes + firstFile.bytes,
    };
    const privateFile = {
      ...base,
      files: [
        ...base.files,
        { path: "user-data/openbot-team-server-v2.json", bytes: 1, sha256: hash(Buffer.from("x")) },
      ],
      totalBytes: base.totalBytes + 1,
    };
    const outsideMissingAttachment = {
      ...base,
      missingAttachmentPaths: ["openbot-migration-path://Shared/../private.png"],
    };
    for (const manifest of [traversal, duplicate, privateFile, outsideMissingAttachment]) {
      await expect(run(service.begin({ memberId: OWNER, requestId: randomUUID(), manifest }))).rejects.toBeInstanceOf(
        ServerMigrationTransferFailure,
      );
    }
    await expect(readdir(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const tooLarge = createService(join(root, "small-limit"), ownerCheck, { transferBytes: 30, fileBytes: 30 });
    await expect(
      run(tooLarge.begin({ memberId: OWNER, requestId: randomUUID(), manifest: base })),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });

    const oversizedFile = createService(join(root, "file-limit"), ownerCheck, { fileBytes: 8 });
    await expect(
      run(oversizedFile.begin({ memberId: OWNER, requestId: randomUUID(), manifest: base })),
    ).rejects.toMatchObject({ code: "invalid_manifest" });
  });

  it("rejects malformed chunks and symlink targets without changing files outside staging", async () => {
    const transfer = await run(service.begin({ memberId: OWNER, requestId: randomUUID(), manifest: makeManifest() }));
    const validBytes = USER_DB.subarray(0, CHUNK_BYTES);
    const valid = {
      memberId: OWNER,
      transferId: transfer.transferId,
      path: "user-data/openbot.db",
      offset: 0,
      bytes: validBytes,
      sha256: hash(validBytes),
    };
    await expect(run(service.writeChunk({ ...valid, sha256: "0".repeat(64) }))).rejects.toMatchObject({
      code: "invalid_chunk",
    });
    await expect(run(service.writeChunk({ ...valid, offset: CHUNK_BYTES }))).rejects.toMatchObject({
      code: "invalid_chunk",
    });
    await expect(
      run(
        service.writeChunk({
          ...valid,
          bytes: Buffer.alloc(CHUNK_BYTES + 1),
          sha256: hash(Buffer.alloc(CHUNK_BYTES + 1)),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_chunk" });

    const outside = join(root, "outside.txt");
    const target = join(stagingRoot, transfer.transferId, "snapshot", "user-data/openbot.db");
    await rm(target);
    await writeFile(outside, "do not change");
    await symlink(outside, target);
    await expect(run(service.writeChunk(valid))).rejects.toMatchObject({ code: "invalid_chunk" });
    await expect(readFile(outside, "utf8")).resolves.toBe("do not change");
  });

  it("does not verify or expose an incomplete transfer", async () => {
    const transfer = await run(service.begin({ memberId: OWNER, requestId: randomUUID(), manifest: makeManifest() }));
    await expect(run(service.finalize(OWNER, transfer.transferId))).rejects.toMatchObject({
      code: "transfer_incomplete",
    });
    await expect(
      run(service.withVerifiedSnapshot(OWNER, transfer.transferId, async () => undefined)),
    ).rejects.toMatchObject({ code: "transfer_conflict" });
  });

  it("checks full-file hashes again at finalization", async () => {
    const transfer = await run(service.begin({ memberId: OWNER, requestId: randomUUID(), manifest: makeManifest() }));
    await writeRemaining(service, transfer.transferId, "user-data/openbot.db", USER_DB, 0);
    await writeRemaining(service, transfer.transferId, "home/OpenBot/Shared/Data/agent-data.db", AGENT_DB, 0);
    const target = join(stagingRoot, transfer.transferId, "snapshot", "user-data/openbot.db");
    await writeFile(target, Buffer.alloc(USER_DB.byteLength, 1));
    await expect(run(service.finalize(OWNER, transfer.transferId))).rejects.toMatchObject({
      code: "verification_failed",
    });
  });
});

function createService(
  root: string,
  assertOwner: (memberId: string) => void | Promise<void>,
  limits: { transferBytes?: number; fileBytes?: number } = {},
): ServerMigrationTransferService {
  return new ServerMigrationTransferService({
    stagingRoot: root,
    assertOwner,
    limits: {
      chunkBytes: CHUNK_BYTES,
      transferBytes: 1024,
      retainedBytes: 2048,
      transferCount: 3,
      manifestBytes: 16_384,
      fileCount: 10,
      chunkCount: 32,
      fileBytes: 1024,
      ...limits,
    },
  });
}

function makeManifest(): ServerMigrationSnapshotManifest {
  const files = [
    { path: "user-data/openbot.db", bytes: USER_DB.byteLength, sha256: hash(USER_DB) },
    {
      path: "home/OpenBot/Shared/Data/agent-data.db",
      bytes: AGENT_DB.byteLength,
      sha256: hash(AGENT_DB),
    },
  ].sort((a, b) => a.path.localeCompare(b.path));
  return {
    version: 2,
    createdAt: "2026-10-31T00:00:00.000Z",
    directories: ["user-data", "home", "home/OpenBot", "home/OpenBot/Shared", "home/OpenBot/Shared/Data"].sort(),
    files,
    missingAttachmentPaths: [],
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

async function writeRemaining(
  service: ServerMigrationTransferService,
  transferId: string,
  path: string,
  contents: Buffer,
  startOffset: number,
): Promise<void> {
  for (let offset = startOffset; offset < contents.byteLength; offset += CHUNK_BYTES) {
    const bytes = contents.subarray(offset, Math.min(offset + CHUNK_BYTES, contents.byteLength));
    await run(service.writeChunk({ memberId: OWNER, transferId, path, offset, bytes, sha256: hash(bytes) }));
  }
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}
