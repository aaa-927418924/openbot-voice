import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { legacyCodexHome } from "./codex-home";

export interface CodexHomeMigrationOptions {
  /** The fork's dedicated Codex home. Must be empty or missing before the migration. */
  targetHome: string;
  /** Where the legacy state is read from. Defaults to `~/.codex`. */
  sourceHome?: string;
  /** Where the backup copy of the legacy state is written. Defaults next to the target. */
  backupRoot?: string;
}

export interface CodexHomeMigrationResult {
  migrated: boolean;
  sourceHome: string;
  targetHome: string;
  backupPath: string | null;
  reason?: string;
}

/**
 * Moves the legacy Codex state (`~/.codex`) into the fork's dedicated home with file copies
 * only: a backup copy first, then the copy into the target. It never edits Codex's internal
 * SQLite files, and it refuses to touch a target that already holds state.
 */
export function migrateLegacyCodexHome(options: CodexHomeMigrationOptions): CodexHomeMigrationResult {
  const sourceHome = options.sourceHome ?? legacyCodexHome();
  const { targetHome } = options;
  if (existsSync(targetHome) && readdirSync(targetHome).length > 0) {
    return { migrated: false, sourceHome, targetHome, backupPath: null, reason: "target-not-empty" };
  }
  if (!existsSync(sourceHome)) {
    return { migrated: false, sourceHome, targetHome, backupPath: null, reason: "no-legacy-state" };
  }
  const backupPath = options.backupRoot ?? defaultMigrationBackupPath(targetHome);
  cpSync(sourceHome, backupPath, { recursive: true });
  cpSync(sourceHome, targetHome, { recursive: true });
  return { migrated: true, sourceHome, targetHome, backupPath };
}

/** The default backup location next to the dedicated home, named with the current timestamp. */
export function defaultMigrationBackupPath(targetHome: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(dirname(targetHome), `codex-home-legacy-backup-${stamp}`);
}
