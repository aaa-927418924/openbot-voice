// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMigrationBackupPath, migrateLegacyCodexHome } from "./codex-home-migration";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-codex-migrate-"));
  temporaryRoots.push(root);
  return root;
}

describe("migrateLegacyCodexHome", () => {
  it("copies legacy state to the target and keeps a backup", async () => {
    const root = await temporaryRoot();
    const source = join(root, "legacy");
    const target = join(root, "codex-home");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "auth.json"), "{}");
    const result = migrateLegacyCodexHome({ targetHome: target, sourceHome: source, backupRoot: join(root, "backup") });
    expect(result.migrated).toBe(true);
    await expect(readFile(join(target, "auth.json"), "utf8")).resolves.toBe("{}");
    await expect(readFile(join(root, "backup", "auth.json"), "utf8")).resolves.toBe("{}");
  });

  it("refuses a target that already holds state", async () => {
    const root = await temporaryRoot();
    const source = join(root, "legacy");
    const target = join(root, "codex-home");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "sessions.sqlite"), "existing");
    const result = migrateLegacyCodexHome({ targetHome: target, sourceHome: source, backupRoot: join(root, "backup") });
    expect(result).toEqual(expect.objectContaining({ migrated: false, reason: "target-not-empty", backupPath: null }));
  });

  it("reports missing legacy state without writing", async () => {
    const root = await temporaryRoot();
    const result = migrateLegacyCodexHome({
      targetHome: join(root, "codex-home"),
      sourceHome: join(root, "missing"),
      backupRoot: join(root, "backup"),
    });
    expect(result).toEqual(expect.objectContaining({ migrated: false, reason: "no-legacy-state" }));
  });

  it("names the default backup next to the target", () => {
    expect(defaultMigrationBackupPath("/data/codex-home", new Date("2026-10-07T00:00:00Z"))).toBe(
      "/data/codex-home-legacy-backup-2026-10-07T00-00-00-000Z",
    );
  });
});
