import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createServerMigrationSnapshot,
  importServerMigrationSnapshot,
  ServerMigrationSnapshotError,
  verifyServerMigrationSnapshot,
} from "./server-migration-snapshot";

describe("server migration snapshots", () => {
  let root: string;
  let userDataRoot: string;
  let openBotRoot: string;
  let destinationParent: string;
  const sourceDatabases: DatabaseSync[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-server-migration-"));
    userDataRoot = join(root, "profile");
    openBotRoot = join(root, "OpenBot");
    destinationParent = join(root, "snapshots");
    await Promise.all([mkdir(userDataRoot), mkdir(openBotRoot), mkdir(destinationParent)]);
  });

  afterEach(async () => {
    for (const database of sourceDatabases.splice(0)) database.close();
    await rm(root, { recursive: true, force: true });
  });

  it("captures committed WAL data and the allowlisted chat, workspace, and attachment files", async () => {
    const userDatabasePath = join(userDataRoot, "openbot.db");
    const agentDatabasePath = join(openBotRoot, "Shared", "Data", "agent-data.db");
    await mkdir(join(openBotRoot, "Shared", "Data"), { recursive: true });
    const userDatabase = openWalDatabase(userDatabasePath, "messages", "chat from WAL");
    const agentDatabase = openWalDatabase(agentDatabasePath, "research", "agent table from WAL");
    sourceDatabases.push(userDatabase, agentDatabase);
    expect(await fileExists(`${userDatabasePath}-wal`)).toBe(true);
    expect(await fileExists(`${agentDatabasePath}-wal`)).toBe(true);
    const userDatabaseBefore = await readBytes([userDatabasePath, `${userDatabasePath}-wal`]);
    const agentDatabaseBefore = await readBytes([agentDatabasePath, `${agentDatabasePath}-wal`]);

    await put(userDataRoot, "mailbox.json", JSON.stringify({ version: 3, messages: [], drafts: [] }));
    await put(userDataRoot, "bots.json", "legacy agent roster");
    await put(userDataRoot, "openbot-sidebar-layout-v1.json", "section order");
    await put(userDataRoot, "avatars/agents/agent-a/avatar.png", "agent avatar");
    await put(userDataRoot, "avatars/agents/agent-a/private.txt", "not an image asset");
    await put(userDataRoot, "openbot-team-server-v2.json.assets/logo/7.png", "server logo");
    await put(openBotRoot, "Agents/agent-a/workspace.md", "agent workspace");
    await put(openBotRoot, "Bots/legacy-bot/legacy.md", "legacy workspace");
    await put(openBotRoot, "Shared/Transfers/attachment.mp4", "video attachment");
    await put(openBotRoot, "Downloads/result.pdf", "user download");

    await put(userDataRoot, "openbot-team-server-v2.json", "private signing key and memberships");
    await put(userDataRoot, "openbot-central-auth-v1.bin", "central auth session");
    await put(userDataRoot, "custom-agents.json", "encrypted provider credentials");
    await put(userDataRoot, "openbot-provider-credentials-v1.json", "provider API key");
    await put(userDataRoot, "openbot-mcp-oauth-v1.json", "MCP token");
    await put(userDataRoot, "attachment-drafts/draft/video.mp4", "uncommitted upload");
    await put(userDataRoot, "logs/remote/private.log", "runtime log");
    await put(userDataRoot, "local-skills/private/SKILL.md", "user-level skill not owned by this server");
    await put(openBotRoot, "Downloads/private.txt", "unrelated download");

    const destination = join(destinationParent, "snapshot");
    const created = await createServerMigrationSnapshot({ userDataRoot, openBotRoot, destinationPath: destination });

    expect(created.path).toBe(destination);
    expect(created.manifest.totalBytes).toBe(created.manifest.files.reduce((sum, file) => sum + file.bytes, 0));
    expect(created.manifest.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
    expect(await readFile(join(destination, "home/OpenBot/Shared/Transfers/attachment.mp4"), "utf8")).toBe(
      "video attachment",
    );
    expect(await readFile(join(openBotRoot, "Shared/Transfers/attachment.mp4"), "utf8")).toBe("video attachment");
    expect(await readFile(join(destination, "user-data/avatars/agents/agent-a/avatar.png"), "utf8")).toBe(
      "agent avatar",
    );
    expect(await fileExists(join(destination, "user-data/avatars/agents/agent-a/private.txt"))).toBe(false);
    expect(await readFile(join(destination, "user-data/openbot-sidebar-layout-v1.json"), "utf8")).toBe("section order");
    expect(await readFile(join(destination, "user-data/openbot-team-server-v2.json.assets/logo/7.png"), "utf8")).toBe(
      "server logo",
    );
    expect(created.manifest.files.map((file) => file.path)).not.toContain("user-data/openbot-team-server-v2.json");
    expect(
      created.manifest.files.some((file) => file.path.includes("credentials") || file.path.includes("oauth")),
    ).toBe(false);
    expect(created.manifest.files.some((file) => file.path.startsWith("user-data/attachment-drafts/"))).toBe(false);
    expect(created.manifest.files.some((file) => file.path.startsWith("user-data/logs/"))).toBe(false);
    expect(created.manifest.files.some((file) => file.path.includes("local-skills/"))).toBe(false);
    expect(created.manifest.files.some((file) => file.path.includes("/Downloads/"))).toBe(false);

    const copiedUserDatabase = new DatabaseSync(join(destination, "user-data/openbot.db"), { readOnly: true });
    const copiedAgentDatabase = new DatabaseSync(join(destination, "home/OpenBot/Shared/Data/agent-data.db"), {
      readOnly: true,
    });
    try {
      expect(copiedUserDatabase.prepare("SELECT value FROM messages").get()).toEqual({ value: "chat from WAL" });
      expect(copiedAgentDatabase.prepare("SELECT value FROM research").get()).toEqual({
        value: "agent table from WAL",
      });
    } finally {
      copiedUserDatabase.close();
      copiedAgentDatabase.close();
    }
    expect(await readBytes([userDatabasePath, `${userDatabasePath}-wal`])).toEqual(userDatabaseBefore);
    expect(await readBytes([agentDatabasePath, `${agentDatabasePath}-wal`])).toEqual(agentDatabaseBefore);
    await expect(verifyServerMigrationSnapshot(destination)).resolves.toMatchObject({
      totalBytes: created.manifest.totalBytes,
    });
  });

  it("detects payload tampering and undeclared files", async () => {
    await put(userDataRoot, "mailbox.json", JSON.stringify({ version: 3, messages: [], drafts: [] }));
    await put(openBotRoot, "Agents/agent-a/workspace.md", "original");
    const destination = join(destinationParent, "snapshot");
    await createServerMigrationSnapshot({ userDataRoot, openBotRoot, destinationPath: destination });
    await writeFile(join(destination, "home/OpenBot/Agents/agent-a/workspace.md"), "changed");
    await expect(verifyServerMigrationSnapshot(destination)).rejects.toThrow("integrity check failed");

    await writeFile(join(destination, "home/OpenBot/Agents/extra.txt"), "unexpected");
    await expect(verifyServerMigrationSnapshot(destination)).rejects.toThrow("does not match its manifest");
  });

  it("refuses account and host identity files even when a snapshot manifest authenticates them", async () => {
    await put(userDataRoot, "mailbox.json", JSON.stringify({ version: 3, messages: [], drafts: [] }));
    const snapshotPath = join(destinationParent, "identity-snapshot");
    await createServerMigrationSnapshot({ userDataRoot, openBotRoot, destinationPath: snapshotPath });
    const identityPath = join(snapshotPath, "user-data/openbot-team-server-v2.json");
    const identityContents = Buffer.from(JSON.stringify({ hostId: "private-host-id", signingKey: "private-key" }));
    await writeFile(identityPath, identityContents);
    const manifestPath = join(snapshotPath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.push({
      path: "user-data/openbot-team-server-v2.json",
      bytes: identityContents.byteLength,
      sha256: createHash("sha256").update(identityContents).digest("hex"),
    });
    manifest.totalBytes += identityContents.byteLength;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyServerMigrationSnapshot(snapshotPath)).resolves.toBeDefined();

    const destinationUserData = join(root, "identity-profile", "OpenBot");
    const destinationOpenBot = join(root, "identity-workspace", "OpenBot");
    await mkdir(join(root, "identity-profile"));
    await mkdir(join(root, "identity-workspace"));
    await expect(
      importServerMigrationSnapshot({
        snapshotPath,
        userDataRoot: destinationUserData,
        openBotRoot: destinationOpenBot,
      }),
    ).rejects.toThrow("non-migratable file");
    expect(await fileExists(destinationUserData)).toBe(false);
    expect(await fileExists(destinationOpenBot)).toBe(false);
  });

  it("rejects source symlinks and cleans the unpublished staging directory", async () => {
    await put(openBotRoot, "Agents/agent-a/workspace.md", "workspace");
    await symlink(join(root, "outside-secret.txt"), join(openBotRoot, "Agents", "outside-link"));
    await writeFile(join(root, "outside-secret.txt"), "secret");
    const destination = join(destinationParent, "snapshot");

    await expect(
      createServerMigrationSnapshot({ userDataRoot, openBotRoot, destinationPath: destination }),
    ).rejects.toBeInstanceOf(ServerMigrationSnapshotError);
    expect(await fileExists(destination)).toBe(false);
    expect(await readdir(destinationParent)).toEqual([]);
    expect(await readFile(join(root, "outside-secret.txt"), "utf8")).toBe("secret");
  });

  it("rejects a destination inside either source root and rejects manifest traversal", async () => {
    await expect(
      createServerMigrationSnapshot({
        userDataRoot,
        openBotRoot,
        destinationPath: join(openBotRoot, "missing-parent", "nested", "migration"),
      }),
    ).rejects.toThrow("cannot overlap a source data root");
    expect(await fileExists(join(openBotRoot, "missing-parent"))).toBe(false);

    await put(userDataRoot, "mailbox.json", JSON.stringify({ version: 3, messages: [], drafts: [] }));
    const destination = join(destinationParent, "snapshot");
    const created = await createServerMigrationSnapshot({ userDataRoot, openBotRoot, destinationPath: destination });
    const manifestPath = join(destination, "manifest.json");
    const firstFile = created.manifest.files.at(0);
    if (!firstFile) throw new Error("The fixture must contain a file.");
    firstFile.path = "user-data/../../outside-secret.txt";
    await writeFile(manifestPath, JSON.stringify(created.manifest));
    await expect(verifyServerMigrationSnapshot(destination)).rejects.toThrow("path outside the data allowlist");
  });

  it("rebases attachment paths in JSON columns and mailbox snapshots, preserves the snapshot, and omits MCP secrets", async () => {
    const attachmentPath = join(openBotRoot, "Shared", "Transfers", "report.pdf");
    await put(openBotRoot, "Shared/Transfers/report.pdf", "PDF bytes");
    await mkdir(join(openBotRoot, "Shared", "Data"), { recursive: true });
    const sourceDatabase = new DatabaseSync(join(userDataRoot, "openbot.db"));
    sourceDatabase.exec(`
      CREATE TABLE orchestration_events (
        event_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE projection_attachments (
        attachment_id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL,
        path TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE projection_mailbox_messages (
        message_id TEXT PRIMARY KEY,
        message_json TEXT NOT NULL
      );
      CREATE TABLE file_deletion_outbox (id TEXT PRIMARY KEY, path TEXT NOT NULL);
      CREATE TABLE projection_mcp_servers (mcp_server_id TEXT, env_json TEXT, headers_json TEXT);
    `);
    const attachment = {
      id: "attachment-1",
      name: "report.pdf",
      path: attachmentPath,
      size: 9,
      kind: "file",
      mimeType: "application/pdf",
      previewKind: "pdf",
      sha256: "a".repeat(64),
    };
    const mcpSecret = "MCP_SECRET_NEVER_IN_SNAPSHOT_a90757";
    sourceDatabase
      .prepare("INSERT INTO orchestration_events VALUES (?, ?)")
      .run("event-1", JSON.stringify({ text: `Keep this text ${attachmentPath}`, attachments: [attachment] }));
    sourceDatabase
      .prepare("INSERT INTO projection_attachments VALUES (?, ?, ?, ?)")
      .run(attachment.id, "mailbox-message", attachmentPath, JSON.stringify(attachment));
    sourceDatabase
      .prepare("INSERT INTO projection_mailbox_messages VALUES (?, ?)")
      .run(
        "message-1",
        JSON.stringify({ attachments: [{ id: attachment.id, name: attachment.name, path: attachmentPath }] }),
      );
    sourceDatabase.prepare("INSERT INTO file_deletion_outbox VALUES (?, ?)").run("delete-1", attachmentPath);
    sourceDatabase
      .prepare("INSERT INTO projection_mcp_servers VALUES (?, ?, ?)")
      .run("mcp-1", JSON.stringify({ API_TOKEN: mcpSecret }), JSON.stringify({ Authorization: `Bearer ${mcpSecret}` }));
    sourceDatabase.close();

    const agentDatabase = new DatabaseSync(join(openBotRoot, "Shared", "Data", "agent-data.db"));
    agentDatabase.exec("CREATE TABLE notes (body TEXT NOT NULL);");
    agentDatabase.prepare("INSERT INTO notes VALUES (?)").run(`Keep literal path text ${attachmentPath}`);
    agentDatabase.close();
    await put(
      userDataRoot,
      "mailbox.json",
      JSON.stringify({
        version: 3,
        messages: [{ attachments: [attachment] }],
        drafts: [{ ...attachment, path: join(userDataRoot, "attachment-drafts", "draft.pdf") }],
      }),
    );
    await put(userDataRoot, "attachment-drafts/draft.pdf", "draft bytes");

    const snapshotPath = join(destinationParent, "snapshot-with-attachments");
    await createServerMigrationSnapshot({ userDataRoot, openBotRoot, destinationPath: snapshotPath });
    const portable = "openbot-migration-path://Shared/Transfers/report.pdf";
    const snapshotDatabase = new DatabaseSync(join(snapshotPath, "user-data/openbot.db"), { readOnly: true });
    try {
      const event = JSON.parse(
        String(snapshotDatabase.prepare("SELECT payload_json FROM orchestration_events").get()?.payload_json),
      );
      expect(event.text).toBe(`Keep this text ${attachmentPath}`);
      expect(event.attachments[0].path).toBe(portable);
      expect(snapshotDatabase.prepare("SELECT path FROM projection_attachments").get()).toEqual({ path: portable });
      expect(snapshotDatabase.prepare("SELECT path FROM file_deletion_outbox").get()).toEqual({ path: portable });
      expect(snapshotDatabase.prepare("SELECT COUNT(*) AS count FROM projection_mcp_servers").get()).toEqual({
        count: 0,
      });
    } finally {
      snapshotDatabase.close();
    }
    expect((await readFile(join(snapshotPath, "user-data/openbot.db"))).includes(Buffer.from(mcpSecret))).toBe(false);
    const snapshotMailbox = JSON.parse(await readFile(join(snapshotPath, "user-data/mailbox.json"), "utf8"));
    expect(snapshotMailbox.messages[0].attachments[0].path).toBe(portable);
    expect(snapshotMailbox.drafts).toEqual([]);

    // Exercise import sanitization independently with a valid snapshot that contains an MCP secret.
    const snapshotDatabaseForImport = new DatabaseSync(join(snapshotPath, "user-data/openbot.db"));
    snapshotDatabaseForImport
      .prepare("INSERT INTO projection_mcp_servers VALUES (?, ?, ?)")
      .run("mcp-import", JSON.stringify({ API_TOKEN: mcpSecret }), JSON.stringify({}));
    snapshotDatabaseForImport.close();
    const importDatabaseBytes = await readFile(join(snapshotPath, "user-data/openbot.db"));
    expect(importDatabaseBytes.includes(Buffer.from(mcpSecret))).toBe(true);
    const importManifestPath = join(snapshotPath, "manifest.json");
    const importManifest: {
      files: Array<{ path: string; bytes: number; sha256: string }>;
      totalBytes: number;
    } = JSON.parse(await readFile(importManifestPath, "utf8"));
    const importDatabaseRecord = importManifest.files.find((file) => file.path === "user-data/openbot.db");
    if (!importDatabaseRecord) throw new Error("The fixture must contain the OpenBot database.");
    importDatabaseRecord.bytes = importDatabaseBytes.byteLength;
    importDatabaseRecord.sha256 = createHash("sha256").update(importDatabaseBytes).digest("hex");
    importManifest.totalBytes = importManifest.files.reduce((total, file) => total + file.bytes, 0);
    await writeFile(importManifestPath, JSON.stringify(importManifest));

    const sourceDatabaseAfter = new DatabaseSync(join(userDataRoot, "openbot.db"), { readOnly: true });
    try {
      expect(sourceDatabaseAfter.prepare("SELECT path FROM projection_attachments").get()).toEqual({
        path: attachmentPath,
      });
      expect(sourceDatabaseAfter.prepare("SELECT COUNT(*) AS count FROM projection_mcp_servers").get()).toEqual({
        count: 1,
      });
    } finally {
      sourceDatabaseAfter.close();
    }

    const beforeImport = await readdir(snapshotPath, { recursive: true });
    const destinationUserData = join(root, "new-profile", "OpenBot");
    const destinationOpenBot = join(root, "new-workspace", "OpenBot");
    await mkdir(join(root, "new-profile"));
    await mkdir(join(root, "new-workspace"));
    const imported = await importServerMigrationSnapshot({
      snapshotPath,
      userDataRoot: destinationUserData,
      openBotRoot: destinationOpenBot,
    });
    expect(imported).toMatchObject({ managedAttachmentPathsRebased: true });
    const restoredAttachmentPath = join(destinationOpenBot, "Shared", "Transfers", "report.pdf");
    const restoredDatabase = new DatabaseSync(join(destinationUserData, "openbot.db"), { readOnly: true });
    try {
      expect(restoredDatabase.prepare("SELECT path FROM projection_attachments").get()).toEqual({
        path: restoredAttachmentPath,
      });
      expect(restoredDatabase.prepare("SELECT path FROM file_deletion_outbox").get()).toEqual({
        path: restoredAttachmentPath,
      });
      const restoredEvent = JSON.parse(
        String(restoredDatabase.prepare("SELECT payload_json FROM orchestration_events").get()?.payload_json),
      );
      expect(restoredEvent.text).toBe(`Keep this text ${attachmentPath}`);
      expect(restoredEvent.attachments[0].path).toBe(restoredAttachmentPath);
      expect(restoredDatabase.prepare("SELECT COUNT(*) AS count FROM projection_mcp_servers").get()).toEqual({
        count: 0,
      });
    } finally {
      restoredDatabase.close();
    }
    expect((await readFile(join(destinationUserData, "openbot.db"))).includes(Buffer.from(mcpSecret))).toBe(false);
    const restoredMailbox = JSON.parse(await readFile(join(destinationUserData, "mailbox.json"), "utf8"));
    expect(restoredMailbox.messages[0].attachments[0].path).toBe(restoredAttachmentPath);
    expect(await readFile(restoredAttachmentPath, "utf8")).toBe("PDF bytes");
    expect((await stat(join(destinationOpenBot, "Shared/Data/agent-data.db"))).isFile()).toBe(true);
    expect(await readdir(snapshotPath, { recursive: true })).toEqual(beforeImport);
    await expect(verifyServerMigrationSnapshot(snapshotPath)).resolves.toMatchObject({
      totalBytes: importManifest.totalBytes,
    });
  });

  it("requires new destination roots and does not publish a partial import", async () => {
    const userDatabase = openWalDatabase(join(userDataRoot, "openbot.db"), "messages", "hello");
    const agentPath = join(openBotRoot, "Shared", "Data", "agent-data.db");
    await mkdir(join(openBotRoot, "Shared", "Data"), { recursive: true });
    const agentDatabase = openWalDatabase(agentPath, "notes", "saved");
    sourceDatabases.push(userDatabase, agentDatabase);
    const snapshotPath = join(destinationParent, "fresh-snapshot");
    await createServerMigrationSnapshot({ userDataRoot, openBotRoot, destinationPath: snapshotPath });
    const existingUserRoot = join(root, "already-there");
    await mkdir(existingUserRoot);
    const openBotDestination = join(root, "fresh-workspace");
    await expect(
      importServerMigrationSnapshot({
        snapshotPath,
        userDataRoot: existingUserRoot,
        openBotRoot: openBotDestination,
      }),
    ).rejects.toThrow("must not already exist");
    expect(await readdir(existingUserRoot)).toEqual([]);
    expect(await fileExists(openBotDestination)).toBe(false);
  });

  it("recovers a user root left by a crash between import root publications", async () => {
    const userDatabase = openWalDatabase(join(userDataRoot, "openbot.db"), "messages", "hello");
    const agentPath = join(openBotRoot, "Shared", "Data", "agent-data.db");
    await mkdir(join(openBotRoot, "Shared", "Data"), { recursive: true });
    const agentDatabase = openWalDatabase(agentPath, "notes", "saved");
    sourceDatabases.push(userDatabase, agentDatabase);
    const snapshotPath = join(destinationParent, "recovery-snapshot");
    await createServerMigrationSnapshot({ userDataRoot, openBotRoot, destinationPath: snapshotPath });

    const userDestination = join(root, "recovery-profile", "OpenBot");
    const openBotDestination = join(root, "recovery-workspace", "OpenBot");
    const userStage = join(dirname(userDestination), ".OpenBot.migration-stage-recovery-user");
    const openBotStage = join(dirname(openBotDestination), ".OpenBot.migration-stage-recovery-workspace");
    await mkdir(dirname(userDestination), { recursive: true });
    await mkdir(dirname(openBotDestination), { recursive: true });
    await mkdir(userDestination);
    await put(userDestination, "partial-import.txt", "interrupted publication");
    await writeFile(
      join(userDestination, ".openbot-migration-incomplete.json"),
      JSON.stringify({ userDataRoot: userDestination, openBotRoot: openBotDestination, userStage, openBotStage }),
    );

    await importServerMigrationSnapshot({
      snapshotPath,
      userDataRoot: userDestination,
      openBotRoot: openBotDestination,
    });

    expect(await fileExists(join(userDestination, "partial-import.txt"))).toBe(false);
    expect(await fileExists(join(userDestination, "openbot.db"))).toBe(true);
    expect(await fileExists(join(openBotDestination, "Shared", "Data", "agent-data.db"))).toBe(true);
  });

  it("checks both imported SQLite databases before publishing either destination", async () => {
    const userDatabase = openWalDatabase(join(userDataRoot, "openbot.db"), "messages", "hello");
    const agentPath = join(openBotRoot, "Shared", "Data", "agent-data.db");
    await mkdir(join(openBotRoot, "Shared", "Data"), { recursive: true });
    const agentDatabase = openWalDatabase(agentPath, "notes", "saved");
    sourceDatabases.push(userDatabase, agentDatabase);
    const snapshotPath = join(destinationParent, "corrupt-database-snapshot");
    const created = await createServerMigrationSnapshot({ userDataRoot, openBotRoot, destinationPath: snapshotPath });
    userDatabase.close();
    agentDatabase.close();
    sourceDatabases.splice(sourceDatabases.indexOf(userDatabase), 1);
    sourceDatabases.splice(sourceDatabases.indexOf(agentDatabase), 1);

    const corruptBytes = Buffer.from("not a SQLite database");
    const agentSnapshotPath = join(snapshotPath, "home/OpenBot/Shared/Data/agent-data.db");
    await writeFile(agentSnapshotPath, corruptBytes);
    const manifestPath = join(snapshotPath, "manifest.json");
    const manifest = created.manifest;
    const agentRecord = manifest.files.find((file) => file.path === "home/OpenBot/Shared/Data/agent-data.db");
    if (!agentRecord) throw new Error("The fixture must contain the shared agent database.");
    const previousBytes = agentRecord.bytes;
    agentRecord.bytes = corruptBytes.byteLength;
    agentRecord.sha256 = createHash("sha256").update(corruptBytes).digest("hex");
    manifest.totalBytes += corruptBytes.byteLength - previousBytes;
    await writeFile(manifestPath, JSON.stringify(manifest));

    const userDestination = join(root, "integrity-profile", "OpenBot");
    const openBotDestination = join(root, "integrity-workspace", "OpenBot");
    await mkdir(join(root, "integrity-profile"));
    await mkdir(join(root, "integrity-workspace"));
    await expect(
      importServerMigrationSnapshot({
        snapshotPath,
        userDataRoot: userDestination,
        openBotRoot: openBotDestination,
      }),
    ).rejects.toThrow("SQLite integrity_check failed");
    expect(await fileExists(userDestination)).toBe(false);
    expect(await fileExists(openBotDestination)).toBe(false);
    await expect(verifyServerMigrationSnapshot(snapshotPath)).resolves.toBeDefined();
  });

  it("hashes the user database after the member rewrite", async () => {
    const userDatabase = new DatabaseSync(join(userDataRoot, "openbot.db"));
    userDatabase.exec("CREATE TABLE messages (value TEXT NOT NULL)");
    userDatabase.prepare("INSERT INTO messages (value) VALUES ('source owner')").run();
    userDatabase.close();
    await mkdir(join(openBotRoot, "Shared", "Data"), { recursive: true });
    new DatabaseSync(join(openBotRoot, "Shared", "Data", "agent-data.db")).close();

    const destination = join(destinationParent, "rewritten-snapshot");
    const created = await createServerMigrationSnapshot({
      userDataRoot,
      openBotRoot,
      destinationPath: destination,
      rewriteUserDatabase: (databasePath) => {
        const staged = new DatabaseSync(databasePath);
        try {
          staged.prepare("UPDATE messages SET value = 'destination owner'").run();
        } finally {
          staged.close();
        }
      },
    });

    const copied = join(destination, "user-data/openbot.db");
    const copiedBytes = await readFile(copied);
    const listed = created.manifest.files.find((file) => file.path === "user-data/openbot.db");
    expect(listed?.sha256).toBe(createHash("sha256").update(copiedBytes).digest("hex"));
    const readBack = new DatabaseSync(copied, { readOnly: true });
    try {
      expect(readBack.prepare("SELECT value FROM messages").get()).toMatchObject({ value: "destination owner" });
    } finally {
      readBack.close();
    }
    await expect(verifyServerMigrationSnapshot(destination)).resolves.toBeDefined();
  });

  it("refuses attachment references outside the portable data roots", async () => {
    const outsidePath = join(root, "private.txt");
    await writeFile(outsidePath, "private");
    const attachment = {
      id: "outside-1",
      name: "private.txt",
      path: outsidePath,
      size: 7,
      kind: "file",
      mimeType: "text/plain",
      previewKind: "text",
      sha256: "b".repeat(64),
    };
    await put(userDataRoot, "mailbox.json", JSON.stringify({ messages: [{ attachments: [attachment] }], drafts: [] }));
    const destination = join(destinationParent, "unsafe-snapshot");
    await expect(
      createServerMigrationSnapshot({ userDataRoot, openBotRoot, destinationPath: destination }),
    ).rejects.toThrow("outside the included OpenBot data roots");
    expect(await fileExists(destination)).toBe(false);
  });
});

function openWalDatabase(path: string, table: string, value: string): DatabaseSync {
  const database = new DatabaseSync(path, { timeout: 5_000 });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  database.exec(`CREATE TABLE ${table} (value TEXT NOT NULL);`);
  database.prepare(`INSERT INTO ${table} (value) VALUES (?)`).run(value);
  return database;
}

async function put(rootPath: string, relativePath: string, contents: string): Promise<void> {
  const path = join(rootPath, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

async function readBytes(paths: string[]): Promise<string[]> {
  return Promise.all(paths.map(async (path) => Buffer.from(await readFile(path)).toString("base64")));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
