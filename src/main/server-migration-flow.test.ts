import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TeamMemberSummary } from "@openbot/contracts/ipc";
import { SERVER_MIGRATION_CHUNK_BYTES_LIMIT } from "@openbot/contracts/team-protocol/server-migration-v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerMigrationDestination } from "./server-migration-destination";
import { createLocalServerMigrationPeer } from "./server-migration-local-peer";
import { type ServerMigrationJobSnapshot, ServerMigrationSourceService } from "./server-migration-source";

const owner: TeamMemberSummary = {
  id: "owner-1",
  username: "owner",
  email: "owner@example.test",
  name: "Owner",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  disabled: false,
};

describe("local-to-server migration flow", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("resumes after a mid-transfer failure, activates the destination, and retains source data", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-migration-flow-"));
    const sourceUserData = join(root, "source-profile");
    const sourceOpenBot = join(root, "source-OpenBot");
    const destinationUserData = join(root, "cloud-profile");
    const destinationOpenBot = join(root, "cloud-OpenBot");
    const largeWorkspaceFile = join(sourceOpenBot, "Agents", "agent-1", "workspace.bin");
    await Promise.all([
      mkdir(sourceUserData, { recursive: true }),
      mkdir(join(sourceOpenBot, "Shared", "Data"), { recursive: true }),
      mkdir(join(sourceOpenBot, "Agents", "agent-1"), { recursive: true }),
      mkdir(destinationUserData, { recursive: true }),
      mkdir(join(destinationOpenBot, "Shared", "Data"), { recursive: true }),
    ]);
    writeDatabase(join(sourceUserData, "openbot.db"), "source chat history");
    writeDatabase(join(sourceOpenBot, "Shared", "Data", "agent-data.db"), "source agent data");
    const missingAttachmentId = "8bc95574-c965-431c-bb7f-d7cf09ed3673";
    const missingAttachmentName = "Dario-Amodei-full-body.png";
    const missingAttachmentPath = join(
      sourceOpenBot,
      "Shared",
      "Transfers",
      "generated",
      missingAttachmentId,
      missingAttachmentName,
    );
    const sourceDatabase = new DatabaseSync(join(sourceUserData, "openbot.db"));
    sourceDatabase.exec(`
      CREATE TABLE projection_attachments (
        attachment_id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL,
        path TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
    `);
    sourceDatabase
      .prepare("INSERT INTO projection_attachments VALUES (?, ?, ?, ?)")
      .run(
        missingAttachmentId,
        "generated",
        missingAttachmentPath,
        JSON.stringify({ id: missingAttachmentId, name: missingAttachmentName, path: missingAttachmentPath }),
      );
    sourceDatabase.close();
    writeDatabase(join(destinationUserData, "openbot.db"), "old destination history");
    writeDatabase(join(destinationOpenBot, "Shared", "Data", "agent-data.db"), "old destination agents");
    await writeFile(largeWorkspaceFile, Buffer.alloc(SERVER_MIGRATION_CHUNK_BYTES_LIMIT + 1, 7));

    const activated = vi.fn();
    const destination = new ServerMigrationDestination({
      userDataRoot: destinationUserData,
      openBotRoot: destinationOpenBot,
      stagingRoot: join(root, "destination-staging"),
      assertOwner: async (memberId) => {
        if (memberId !== owner.id) throw new Error("The test member does not own the destination.");
      },
      onActivated: activated,
    });
    const localPeer = createLocalServerMigrationPeer({
      serverId: "cloud",
      serverName: "Cloud server",
      migration: destination.migration,
      memberId: owner.id,
      members: () => [owner],
    });
    let successfulChunks = 0;
    let injectedFailure = false;
    const peer = {
      ...localPeer,
      writeChunk: async (input: Parameters<typeof localPeer.writeChunk>[0]) => {
        if (successfulChunks === 1 && !injectedFailure) {
          injectedFailure = true;
          throw new Error("The test connection dropped after one chunk.");
        }
        const status = await localPeer.writeChunk(input);
        successfulChunks += 1;
        return status;
      },
    };

    let finishFailure!: (snapshot: ServerMigrationJobSnapshot) => void;
    let finishSuccess!: (snapshot: ServerMigrationJobSnapshot) => void;
    const failed = new Promise<ServerMigrationJobSnapshot>((resolve) => {
      finishFailure = resolve;
    });
    const completed = new Promise<ServerMigrationJobSnapshot>((resolve) => {
      finishSuccess = resolve;
    });
    const source = new ServerMigrationSourceService({
      userDataRoot: sourceUserData,
      openBotRoot: sourceOpenBot,
      stagingRoot: join(root, "source-staging"),
      localMembers: () => [owner],
      localOwnerMemberId: () => owner.id,
      sourceServerId: () => "local",
      destinations: () => [
        { serverId: "local", serverName: "Local server" },
        { serverId: "cloud", serverName: "Cloud server" },
      ],
      peerFor: (serverId) => (serverId === "cloud" ? peer : null),
      onChange: (snapshot) => {
        if (snapshot.phase === "failed") finishFailure(snapshot);
        if (snapshot.phase === "completed") finishSuccess(snapshot);
      },
    });

    expect(source.destinations()).toEqual([{ serverId: "cloud", serverName: "Cloud server" }]);

    const initial = source.start("cloud");
    const firstAttempt = await failed;
    expect(firstAttempt.jobId).toBe(initial.jobId);
    expect(firstAttempt.phase).toBe("failed");
    expect(firstAttempt.retryable).toBe(true);
    expect(firstAttempt.transferredBytes).toBe(SERVER_MIGRATION_CHUNK_BYTES_LIMIT);
    expect(firstAttempt.message).toBe("The test connection dropped after one chunk.");

    source.retry(initial.jobId);
    const result = await completed;
    expect(result.phase).toBe("completed");
    expect(result.transferredBytes).toBe(result.totalBytes);
    expect(activated).toHaveBeenCalledOnce();

    expect(readDatabase(join(sourceUserData, "openbot.db"))).toBe("source chat history");
    expect(readDatabase(join(sourceOpenBot, "Shared", "Data", "agent-data.db"))).toBe("source agent data");
    expect(readDatabase(join(destinationUserData, "openbot.db"))).toBe("source chat history");
    expect(readDatabase(join(destinationOpenBot, "Shared", "Data", "agent-data.db"))).toBe("source agent data");
    expect(await readFile(join(destinationOpenBot, "Agents", "agent-1", "workspace.bin"))).toEqual(
      Buffer.alloc(SERVER_MIGRATION_CHUNK_BYTES_LIMIT + 1, 7),
    );
    expect(await readFile(largeWorkspaceFile)).toEqual(Buffer.alloc(SERVER_MIGRATION_CHUNK_BYTES_LIMIT + 1, 7));
    expect(result.message).toBeTruthy();
    const migratedDatabase = new DatabaseSync(join(destinationUserData, "openbot.db"), { readOnly: true });
    try {
      expect(migratedDatabase.prepare("SELECT path FROM projection_attachments").get()).toEqual({
        path: join(destinationOpenBot, "Shared", "Transfers", "generated", missingAttachmentId, missingAttachmentName),
      });
    } finally {
      migratedDatabase.close();
    }
    expect(await fileExists(missingAttachmentPath)).toBe(false);
    expect(
      await fileExists(
        join(destinationOpenBot, "Shared", "Transfers", "generated", missingAttachmentId, missingAttachmentName),
      ),
    ).toBe(false);
  }, 30_000);
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function writeDatabase(path: string, value: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE test_values (value TEXT NOT NULL)");
    database.prepare("INSERT INTO test_values (value) VALUES (?)").run(value);
  } finally {
    database.close();
  }
}

function readDatabase(path: string): string {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const result = database.prepare("SELECT value FROM test_values").get();
    return result && typeof result === "object" && "value" in result ? String(result.value) : "";
  } finally {
    database.close();
  }
}
