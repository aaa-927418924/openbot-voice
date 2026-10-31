import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerMigrationDestination } from "./server-migration-destination";
import { createServerMigrationSnapshot } from "./server-migration-snapshot";

describe("the server migration destination", () => {
  let root: string;
  let userDataRoot: string;
  let openBotRoot: string;
  let snapshotPath: string;
  let manifest: Awaited<ReturnType<typeof createServerMigrationSnapshot>>["manifest"];
  const openDatabases: DatabaseSync[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-migration-destination-"));
    userDataRoot = join(root, "profile");
    openBotRoot = join(root, "OpenBot");
    const sourceUserData = join(root, "source-profile");
    const sourceOpenBot = join(root, "source-OpenBot");
    await Promise.all([
      mkdir(join(userDataRoot, "avatars", "agents"), { recursive: true }),
      mkdir(join(openBotRoot, "Agents", "old-agent"), { recursive: true }),
      mkdir(join(sourceUserData, "avatars", "agents", "new-agent"), { recursive: true }),
      mkdir(join(sourceOpenBot, "Agents", "new-agent"), { recursive: true }),
      mkdir(join(sourceOpenBot, "Shared", "Data"), { recursive: true }),
    ]);
    // This host's own identity. It must survive the import, because the imported data came from
    // another computer.
    await writeFile(join(userDataRoot, "openbot-team-server-v2.json"), "destination identity");
    await writeFile(join(userDataRoot, "self-hosted-identity.json"), "destination auth");
    await writeDatabase(join(userDataRoot, "openbot.db"), "destination chat");
    await writeDatabase(join(sourceUserData, "openbot.db"), "source chat");
    await writeDatabase(join(sourceOpenBot, "Shared", "Data", "agent-data.db"), "source agent data");
    await writeFile(join(sourceOpenBot, "Agents", "new-agent", "workspace.md"), "migrated workspace");
    await writeFile(join(sourceUserData, "avatars", "agents", "new-agent", "avatar.png"), "migrated avatar");

    snapshotPath = join(root, "snapshots", "snapshot-1");
    await mkdir(dirname(snapshotPath), { recursive: true });
    const created = await createServerMigrationSnapshot({
      userDataRoot: sourceUserData,
      openBotRoot: sourceOpenBot,
      destinationPath: snapshotPath,
    });
    manifest = created.manifest;
  });

  afterEach(async () => {
    for (const database of openDatabases.splice(0)) database.close();
    await rm(root, { recursive: true, force: true });
  });

  async function writeDatabase(path: string, value: string): Promise<void> {
    const database = new DatabaseSync(path);
    openDatabases.push(database);
    database.exec("CREATE TABLE messages (value TEXT NOT NULL)");
    database.prepare("INSERT INTO messages (value) VALUES (?)").run(value);
  }

  function readDatabase(path: string): string {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database.prepare("SELECT value FROM messages").get();
      return row && typeof row === "object" && "value" in row ? String(row.value) : "";
    } finally {
      database.close();
    }
  }

  function create(onActivated: () => void): ServerMigrationDestination {
    return new ServerMigrationDestination({
      userDataRoot,
      openBotRoot,
      stagingRoot: join(root, "staging"),
      assertOwner: async (memberId) => {
        if (memberId !== "owner-1") throw new Error("not the owner");
      },
      onActivated,
    });
  }

  async function backupNames(): Promise<string[]> {
    return (await readdir(root)).filter((name) => name.includes(".openbot-migration-backup-")).sort();
  }

  it("replaces the portable roots, keeps the destination identity, and retains both old roots", async () => {
    const activated = vi.fn();
    const service = create(activated);
    await service.migration.activate({ memberId: "owner-1", transferId: "transfer-1", snapshotPath, manifest });

    expect(readDatabase(join(userDataRoot, "openbot.db"))).toBe("source chat");
    expect(readDatabase(join(openBotRoot, "Shared", "Data", "agent-data.db"))).toBe("source agent data");
    expect(await readFile(join(openBotRoot, "Agents", "new-agent", "workspace.md"), "utf8")).toBe("migrated workspace");
    // The destination's own identity files are copied over the staged snapshot before publication.
    expect(await readFile(join(userDataRoot, "openbot-team-server-v2.json"), "utf8")).toBe("destination identity");
    expect(await readFile(join(userDataRoot, "self-hosted-identity.json"), "utf8")).toBe("destination auth");
    expect(activated).toHaveBeenCalledOnce();

    const backups = await backupNames();
    expect(backups).toHaveLength(2);
    for (const name of backups) expect((await stat(join(root, name))).isDirectory()).toBe(true);
    expect(await readFile(join(root, `.profile.server-migration-activation`, "transfer-1.json"), "utf8")).toContain(
      '"phase":"activated"',
    );
  });

  it("does nothing when the same transfer activates again", async () => {
    const activated = vi.fn();
    const service = create(activated);
    await service.migration.activate({ memberId: "owner-1", transferId: "transfer-1", snapshotPath, manifest });
    const backups = await backupNames();

    await service.migration.activate({ memberId: "owner-1", transferId: "transfer-1", snapshotPath, manifest });

    expect(activated).toHaveBeenCalledOnce();
    expect(await backupNames()).toEqual(backups);
    expect(readDatabase(join(userDataRoot, "openbot.db"))).toBe("source chat");
  });

  it("refuses a member that is not the owner before it changes any root", async () => {
    const service = create(vi.fn());
    await expect(
      Effect.runPromise(
        service.transfer.begin({
          memberId: "member-2",
          requestId: "3f660c39-4f80-4a0c-9f5a-4f6e7b2f2a10",
          manifest,
        }),
      ),
    ).rejects.toThrow();

    expect(readDatabase(join(userDataRoot, "openbot.db"))).toBe("destination chat");
    await expect(readFile(join(userDataRoot, "openbot-team-server-v2.json"), "utf8")).resolves.toBe(
      "destination identity",
    );
  });
});
