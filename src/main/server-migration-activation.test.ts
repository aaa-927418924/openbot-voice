import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateServerMigrationRoots,
  recoverServerMigrationActivation,
  ServerMigrationActivationFailure,
  serverMigrationActivationJournalPath,
} from "./server-migration-activation";

describe("server migration root activation", () => {
  let root: string;
  let userDataRoot: string;
  let openBotRoot: string;
  let stagedUserDataRoot: string;
  let stagedOpenBotRoot: string;
  let sourceRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-server-activation-"));
    userDataRoot = join(root, "profile");
    openBotRoot = join(root, "OpenBot");
    stagedUserDataRoot = join(root, "profile.stage");
    stagedOpenBotRoot = join(root, "OpenBot.stage");
    sourceRoot = join(root, "source");
    await Promise.all([
      mkdir(userDataRoot),
      mkdir(openBotRoot),
      mkdir(stagedUserDataRoot),
      mkdir(stagedOpenBotRoot),
      mkdir(sourceRoot),
    ]);
    await writeFile(join(userDataRoot, "state.txt"), "current profile");
    await writeFile(join(openBotRoot, "state.txt"), "current workspace");
    await writeFile(join(stagedUserDataRoot, "state.txt"), "imported profile");
    await writeFile(join(stagedOpenBotRoot, "state.txt"), "imported workspace");
    await writeFile(join(sourceRoot, "state.txt"), "source remains untouched");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the current pair until activation, then retains both roots as backups", async () => {
    await expect(readFile(join(userDataRoot, "state.txt"), "utf8")).resolves.toBe("current profile");
    await expect(readFile(join(openBotRoot, "state.txt"), "utf8")).resolves.toBe("current workspace");

    const activated = await Effect.runPromise(
      activateServerMigrationRoots({
        userDataRoot,
        openBotRoot,
        stagedUserDataRoot,
        stagedOpenBotRoot,
      }),
    );

    await expect(readFile(join(userDataRoot, "state.txt"), "utf8")).resolves.toBe("imported profile");
    await expect(readFile(join(openBotRoot, "state.txt"), "utf8")).resolves.toBe("imported workspace");
    await expect(readFile(join(activated.userDataBackupRoot, "state.txt"), "utf8")).resolves.toBe("current profile");
    await expect(readFile(join(activated.openBotBackupRoot, "state.txt"), "utf8")).resolves.toBe("current workspace");
    await expect(readFile(join(sourceRoot, "state.txt"), "utf8")).resolves.toBe("source remains untouched");
    await expect(readdir(stagedUserDataRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(stagedOpenBotRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(serverMigrationActivationJournalPath(userDataRoot), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rolls back a crash after one new root was published and restores the old pair", async () => {
    const transactionId = "00000000-0000-4000-8000-000000000001";
    const userDataBackupRoot = backupPath(userDataRoot, transactionId);
    const openBotBackupRoot = backupPath(openBotRoot, transactionId);
    await rename(userDataRoot, userDataBackupRoot);
    await rename(openBotRoot, openBotBackupRoot);
    await rename(stagedUserDataRoot, userDataRoot);
    await writeFixtureJournal({
      userDataRoot,
      openBotRoot,
      stagedUserDataRoot,
      stagedOpenBotRoot,
      userDataBackupRoot,
      openBotBackupRoot,
      transactionId,
      phase: "user-data-published",
    });

    await expect(Effect.runPromise(recoverServerMigrationActivation({ userDataRoot, openBotRoot }))).resolves.toEqual({
      status: "rolled-back",
    });
    await expect(readFile(join(userDataRoot, "state.txt"), "utf8")).resolves.toBe("current profile");
    await expect(readFile(join(openBotRoot, "state.txt"), "utf8")).resolves.toBe("current workspace");
    await expect(readFile(join(stagedUserDataRoot, "state.txt"), "utf8")).resolves.toBe("imported profile");
    await expect(readFile(join(stagedOpenBotRoot, "state.txt"), "utf8")).resolves.toBe("imported workspace");
    await expect(readdir(userDataBackupRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(openBotBackupRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(sourceRoot, "state.txt"), "utf8")).resolves.toBe("source remains untouched");
  });

  it("repeats recovery safely after interruption during the rollback itself", async () => {
    const transactionId = "00000000-0000-4000-8000-000000000002";
    const openBotBackupRoot = backupPath(openBotRoot, transactionId);
    await rename(openBotRoot, openBotBackupRoot);
    // The userData half is already restored. The workspace half still needs its old backup.
    await writeFixtureJournal({
      userDataRoot,
      openBotRoot,
      stagedUserDataRoot,
      stagedOpenBotRoot,
      userDataBackupRoot: backupPath(userDataRoot, transactionId),
      openBotBackupRoot,
      transactionId,
      phase: "both-roots-backed-up",
    });

    await expect(Effect.runPromise(recoverServerMigrationActivation({ userDataRoot, openBotRoot }))).resolves.toEqual({
      status: "rolled-back",
    });
    await expect(readFile(join(userDataRoot, "state.txt"), "utf8")).resolves.toBe("current profile");
    await expect(readFile(join(openBotRoot, "state.txt"), "utf8")).resolves.toBe("current workspace");
    await expect(readFile(join(stagedOpenBotRoot, "state.txt"), "utf8")).resolves.toBe("imported workspace");
    await expect(readFile(join(sourceRoot, "state.txt"), "utf8")).resolves.toBe("source remains untouched");
  });

  it("keeps committed roots and backups when startup finishes journal cleanup", async () => {
    const transactionId = "00000000-0000-4000-8000-000000000003";
    const userDataBackupRoot = backupPath(userDataRoot, transactionId);
    const openBotBackupRoot = backupPath(openBotRoot, transactionId);
    await rename(userDataRoot, userDataBackupRoot);
    await rename(openBotRoot, openBotBackupRoot);
    await rename(stagedUserDataRoot, userDataRoot);
    await rename(stagedOpenBotRoot, openBotRoot);
    await writeFixtureJournal({
      userDataRoot,
      openBotRoot,
      stagedUserDataRoot,
      stagedOpenBotRoot,
      userDataBackupRoot,
      openBotBackupRoot,
      transactionId,
      phase: "committed",
    });

    await expect(Effect.runPromise(recoverServerMigrationActivation({ userDataRoot, openBotRoot }))).resolves.toEqual({
      status: "committed",
    });
    await expect(readFile(join(userDataRoot, "state.txt"), "utf8")).resolves.toBe("imported profile");
    await expect(readFile(join(openBotRoot, "state.txt"), "utf8")).resolves.toBe("imported workspace");
    await expect(readFile(join(userDataBackupRoot, "state.txt"), "utf8")).resolves.toBe("current profile");
    await expect(readFile(join(openBotBackupRoot, "state.txt"), "utf8")).resolves.toBe("current workspace");
    await expect(readdir(userDataBackupRoot)).resolves.toContain("state.txt");
    await expect(readdir(openBotBackupRoot)).resolves.toContain("state.txt");
    await expect(readFile(serverMigrationActivationJournalPath(userDataRoot), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed before changing either root when the journal names an impossible mixed state", async () => {
    const transactionId = "00000000-0000-4000-8000-000000000004";
    const userDataBackupRoot = backupPath(userDataRoot, transactionId);
    const openBotBackupRoot = backupPath(openBotRoot, transactionId);
    await rename(userDataRoot, userDataBackupRoot);
    await rename(openBotRoot, openBotBackupRoot);
    await rename(stagedUserDataRoot, userDataRoot);
    await mkdir(stagedUserDataRoot);
    await writeFile(join(stagedUserDataRoot, "state.txt"), "duplicate staged root");
    await writeFixtureJournal({
      userDataRoot,
      openBotRoot,
      stagedUserDataRoot,
      stagedOpenBotRoot,
      userDataBackupRoot,
      openBotBackupRoot,
      transactionId,
      phase: "both-roots-backed-up",
    });

    await expect(
      Effect.runPromise(recoverServerMigrationActivation({ userDataRoot, openBotRoot })),
    ).rejects.toBeInstanceOf(ServerMigrationActivationFailure);
    await expect(readFile(join(userDataRoot, "state.txt"), "utf8")).resolves.toBe("imported profile");
    await expect(readFile(join(openBotBackupRoot, "state.txt"), "utf8")).resolves.toBe("current workspace");
    await expect(readdir(openBotRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(serverMigrationActivationJournalPath(userDataRoot), "utf8")).resolves.toContain(
      "both-roots-backed-up",
    );
  });
});

function backupPath(activeRoot: string, transactionId: string): string {
  return join(dirname(activeRoot), `.${basename(activeRoot)}.openbot-migration-backup-${transactionId}`);
}

async function writeFixtureJournal({
  userDataRoot,
  openBotRoot,
  stagedUserDataRoot,
  stagedOpenBotRoot,
  userDataBackupRoot,
  openBotBackupRoot,
  transactionId,
  phase,
}: {
  userDataRoot: string;
  openBotRoot: string;
  stagedUserDataRoot: string;
  stagedOpenBotRoot: string;
  userDataBackupRoot: string;
  openBotBackupRoot: string;
  transactionId: string;
  phase:
    | "prepared"
    | "user-data-backed-up"
    | "both-roots-backed-up"
    | "user-data-published"
    | "both-roots-published"
    | "committed";
}): Promise<void> {
  await writeFile(
    serverMigrationActivationJournalPath(userDataRoot),
    `${JSON.stringify({
      version: 1,
      transactionId,
      phase,
      roots: {
        userData: { active: userDataRoot, staged: stagedUserDataRoot, backup: userDataBackupRoot },
        workspace: { active: openBotRoot, staged: stagedOpenBotRoot, backup: openBotBackupRoot },
      },
    })}\n`,
    { mode: 0o600 },
  );
}
