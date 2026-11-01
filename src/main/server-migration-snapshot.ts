import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { z } from "zod";

export const SERVER_MIGRATION_SNAPSHOT_VERSION = 2;

export interface ServerMigrationSnapshotFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ServerMigrationSnapshotManifest {
  version: typeof SERVER_MIGRATION_SNAPSHOT_VERSION;
  createdAt: string;
  directories: string[];
  files: ServerMigrationSnapshotFile[];
  /** Portable references whose source file was already absent before snapshot creation. */
  missingAttachmentPaths?: string[];
  totalBytes: number;
}

export interface ServerMigrationSnapshotOptions {
  /** Electron's userData directory, normally `~/.config/OpenBot`. */
  userDataRoot: string;
  /** The `~/OpenBot` workspace root. */
  openBotRoot: string;
  /** New, non-existing path on the destination volume. The source is never moved or changed. */
  destinationPath: string;
  /**
   * Rewrites the staged `openbot.db` before the snapshot hashes it. The callback gets a private path
   * to the staged copy; the source database is only ever opened read-only.
   */
  rewriteUserDatabase?: (stagedDatabasePath: string) => Promise<void> | void;
}

export interface CreatedServerMigrationSnapshot {
  path: string;
  manifest: ServerMigrationSnapshotManifest;
}

export interface ImportServerMigrationSnapshotOptions {
  /** The verified snapshot created by {@link createServerMigrationSnapshot}. */
  snapshotPath: string;
  /** New, non-existing Electron userData directory. Its parent must already exist. */
  userDataRoot: string;
  /** New, non-existing `~/OpenBot` workspace directory. Its parent must already exist. */
  openBotRoot: string;
  /** Final `~/OpenBot` path to embed in attachment references when `openBotRoot` is a staging path. */
  attachmentOpenBotRoot?: string;
}

export interface ImportedServerMigrationSnapshot {
  userDataRoot: string;
  openBotRoot: string;
  manifest: ServerMigrationSnapshotManifest;
  /** OpenBot-managed attachment references in mailbox.json/openbot.db are rebased to the new root. */
  managedAttachmentPathsRebased: true;
}

export class ServerMigrationSnapshotError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServerMigrationSnapshotError";
  }
}

const SNAPSHOT_MANIFEST_FILE = "manifest.json";
const IMPORT_RECOVERY_FILE = ".openbot-migration-incomplete.json";
const PORTABLE_OPENBOT_PATH_PREFIX = "openbot-migration-path://";
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const MANIFEST_PATH_PREFIXES = ["user-data/", "home/OpenBot/"] as const;
const MANIFEST_ROOT_PATHS = new Set(["user-data", "home", "home/OpenBot"]);
const snapshotFileSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const importRecoverySchema = z
  .object({
    userDataRoot: z.string(),
    openBotRoot: z.string(),
    userStage: z.string(),
    openBotStage: z.string(),
    phase: z.enum(["publishing", "complete"]).default("publishing"),
  })
  .strict();
const snapshotManifestSchema = z
  .object({
    version: z.literal(SERVER_MIGRATION_SNAPSHOT_VERSION),
    createdAt: z.string(),
    directories: z.array(z.string()),
    files: z.array(snapshotFileSchema),
    missingAttachmentPaths: z.array(z.string().max(4096)).optional().default([]),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();

/**
 * This is the data allowlist. Paths are relative to `userDataRoot` or `openBotRoot` and are
 * intentionally fixed rather than accepted from an IPC payload.
 *
 * Included from userData: the SQLite source of truth (with WAL captured by VACUUM INTO), the
 * pre-SQLite mailbox and agent-roster import files, sidebar section/order state, agent avatar
 * images, and only the server-logo asset subdirectories. Channels, agent profiles, chat history,
 * queues, and other structured state live in openbot.db.
 *
 * Included from ~/OpenBot: agent workspaces, legacy Bot workspaces, and Shared (including Transfers
 * attachments and Data/agent-data.db). The unrelated Downloads folder is not copied.
 *
 * Managed attachment paths in mailbox.json and openbot.db are replaced with portable relative markers
 * in the snapshot and rebased at import. Shared/Data/agent-data.db contains arbitrary user-created
 * tables rather than an OpenBot attachment registry, so its user data is preserved verbatim.
 *
 * Explicitly excluded: openbot-team-server-v2.json and v1 (host IDs, signing/private keys,
 * password hashes, account membership/session records), custom-agents.json (encrypted credential
 * payloads), the MCP server configuration rows in openbot.db (their args, environment, URLs and
 * headers may contain credentials), central-auth/provider/GitHub/1Password/messaging/remote-desktop credentials,
 * provider-owned ~/.codex/~/.claude/etc login state, attachment-drafts (uncommitted transient
 * uploads), user-level local skills, the unrelated Downloads tree, provider runtimes/caches, logs,
 * browser state, analytics, app preferences, and local server preferences. The destination host
 * must create its own host identity and auth state.
 */
const USER_DATA_FILE_PATHS = ["openbot.db", "mailbox.json", "bots.json", "openbot-sidebar-layout-v1.json"] as const;
const USER_DATA_DIRECTORY_PATHS = [
  "avatars/agents",
  "openbot-team-server-v2.json.assets/logo",
  "openbot-team-server-v1.json.assets/logo",
] as const;
const OPENBOT_DIRECTORY_PATHS = ["Agents", "Bots", "Shared"] as const;
const AGENT_DATABASE_RELATIVE_PATH = "Shared/Data/agent-data.db";
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

interface SourceRoots {
  userDataRoot: string;
  openBotRoot: string;
}

interface SnapshotBuilder {
  stagePath: string;
  directories: Set<string>;
  files: ServerMigrationSnapshotFile[];
  attachmentPaths: Map<string, boolean>;
}

interface WalkOptions {
  skipRelativePaths?: ReadonlySet<string>;
}

/**
 * Create a portable, integrity-checked snapshot in a sibling staging directory and publish it
 * into a destination claimed with an exclusive directory creation. SQLite databases are read-only sources and are copied with SQLite's
 * `VACUUM INTO`, which reads the committed WAL state as one consistent database snapshot.
 */
export async function createServerMigrationSnapshot(
  options: ServerMigrationSnapshotOptions,
): Promise<CreatedServerMigrationSnapshot> {
  const roots = await resolveSourceRoots(options);
  const destination = await resolveDestination(options.destinationPath, roots);
  const parentPath = dirname(destination);
  const stagePath = await mkdtemp(join(parentPath, `.${basename(destination)}.stage-${randomUUID()}-`));
  const builder: SnapshotBuilder = {
    stagePath,
    directories: new Set(),
    files: [],
    attachmentPaths: new Map(),
  };

  try {
    await makeOutputDirectory(builder, "user-data");
    await makeOutputDirectory(builder, "home");
    await makeOutputDirectory(builder, "home/OpenBot");

    const openBotDatabaseSidecars = sidecarPaths(join(roots.openBotRoot, AGENT_DATABASE_RELATIVE_PATH));
    const skippedSharedPaths = new Set([
      AGENT_DATABASE_RELATIVE_PATH,
      ...openBotDatabaseSidecars.map((path) => relative(roots.openBotRoot, path).split(sep).join("/")),
    ]);

    for (const relativePath of USER_DATA_FILE_PATHS) {
      const outputPath = `user-data/${relativePath}`;
      if (relativePath === "openbot.db") {
        await rejectUnexpectedSqliteSidecars(join(roots.userDataRoot, relativePath));
        await snapshotOptionalSqlite(
          roots.userDataRoot,
          relativePath,
          builder,
          outputPath,
          roots.openBotRoot,
          options.rewriteUserDatabase ? (databasePath) => options.rewriteUserDatabase?.(databasePath) : undefined,
        );
      } else if (relativePath === "mailbox.json") {
        await snapshotMailboxState(roots.userDataRoot, relativePath, builder, roots.openBotRoot);
      } else {
        await copyOptionalFile(roots.userDataRoot, relativePath, builder, outputPath);
      }
    }

    for (const relativePath of USER_DATA_DIRECTORY_PATHS) {
      await copyOptionalTree(roots.userDataRoot, relativePath, builder, `user-data/${relativePath}`);
    }

    for (const relativePath of OPENBOT_DIRECTORY_PATHS) {
      await copyOptionalTree(
        roots.openBotRoot,
        relativePath,
        builder,
        `home/OpenBot/${relativePath}`,
        relativePath === "Shared" ? { skipRelativePaths: skippedSharedPaths } : undefined,
      );
    }

    await rejectUnexpectedSqliteSidecars(join(roots.openBotRoot, AGENT_DATABASE_RELATIVE_PATH));
    await snapshotOptionalSqlite(
      roots.openBotRoot,
      AGENT_DATABASE_RELATIVE_PATH,
      builder,
      `home/OpenBot/${AGENT_DATABASE_RELATIVE_PATH}`,
    );

    const missingAttachmentPaths = await validatePortableAttachmentReferences(stagePath, builder);

    builder.files.sort((left, right) => left.path.localeCompare(right.path));
    const directories = [...builder.directories].sort((left, right) => left.localeCompare(right));
    const totalBytes = builder.files.reduce((total, file) => total + file.bytes, 0);
    if (!Number.isSafeInteger(totalBytes)) {
      throw new ServerMigrationSnapshotError("Snapshot data exceeds the supported byte-count range.");
    }
    const manifest: ServerMigrationSnapshotManifest = {
      version: SERVER_MIGRATION_SNAPSHOT_VERSION,
      createdAt: new Date().toISOString(),
      directories,
      files: builder.files,
      ...(missingAttachmentPaths.length > 0 ? { missingAttachmentPaths } : {}),
      totalBytes,
    };
    const manifestPath = join(stagePath, SNAPSHOT_MANIFEST_FILE);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(manifestPath, 0o600);
    await verifyServerMigrationSnapshot(stagePath);

    await publishDirectoryExclusive(stagePath, destination);
    return { path: destination, manifest };
  } catch (cause) {
    await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
    if (cause instanceof ServerMigrationSnapshotError) throw cause;
    throw new ServerMigrationSnapshotError("The server data snapshot could not be created.", { cause });
  }
}

/**
 * Restore a verified portable snapshot into two new roots. The snapshot is copied, never consumed.
 * Both roots are built and checked beside their destinations first. Exclusive directory creation
 * prevents publication from replacing a late target; a recovery journal rolls back interrupted publication.
 */
export async function importServerMigrationSnapshot(
  options: ImportServerMigrationSnapshotOptions,
): Promise<ImportedServerMigrationSnapshot> {
  // Verification is deliberately the first operation: no destination path is created or changed
  // until the complete source tree and its hashes have been checked.
  const manifest = await verifyServerMigrationSnapshot(options.snapshotPath);
  const snapshotRoot = await realpath(resolve(options.snapshotPath));
  assertImportManifestAllowlist(manifest);
  await recoverInterruptedImport(options);
  const roots = await resolveFreshDestinationRoots(options, snapshotRoot);
  const attachmentOpenBotRoot = resolveAttachmentOpenBotRoot(options, roots, snapshotRoot);
  const userStage = await createSiblingStage(roots.userDataRoot);
  let openBotStage: string | null = null;
  let userPublished = false;
  let openBotPublished = false;
  let publicationStarted = false;

  try {
    openBotStage = await createSiblingStage(roots.openBotRoot);
    await materializeSnapshot(snapshotRoot, manifest, userStage, openBotStage);

    const mailboxPath = join(userStage, "mailbox.json");
    const attachmentReferences = await rebaseMailboxFile(mailboxPath, attachmentOpenBotRoot);
    const userDatabasePath = join(userStage, "openbot.db");
    const agentDatabasePath = join(openBotStage, AGENT_DATABASE_RELATIVE_PATH);
    mergeAttachmentReferences(
      attachmentReferences,
      await restoreDatabaseAttachmentPaths(userDatabasePath, attachmentOpenBotRoot),
    );
    await validateSqliteIntegrity(userDatabasePath, "openbot.db");
    await validateSqliteIntegrity(agentDatabasePath, AGENT_DATABASE_RELATIVE_PATH);
    await validateImportedAttachmentReferences(
      attachmentReferences,
      openBotStage,
      attachmentOpenBotRoot,
      manifest.missingAttachmentPaths,
    );

    const recoveryData = { userDataRoot: roots.userDataRoot, openBotRoot: roots.openBotRoot, userStage, openBotStage };
    const recoveryRecord = `${JSON.stringify(recoveryData)}\n`;
    const recoveryJournal = recoveryJournalPath(roots.userDataRoot);
    await Promise.all([
      writeFile(join(userStage, IMPORT_RECOVERY_FILE), recoveryRecord, { flag: "wx", mode: 0o600 }),
      writeFile(join(openBotStage, IMPORT_RECOVERY_FILE), recoveryRecord, { flag: "wx", mode: 0o600 }),
      writeFile(recoveryJournal, recoveryRecord, { flag: "wx", mode: 0o600 }),
    ]);

    // Check both names again immediately before publication. Exclusive mkdir calls below also
    // reject a destination that appears after these checks.
    await assertPathMissing(roots.userDataRoot, "userDataRoot");
    await assertPathMissing(roots.openBotRoot, "openBotRoot");
    publicationStarted = true;
    await publishDirectoryExclusive(userStage, roots.userDataRoot);
    userPublished = true;
    try {
      await publishDirectoryExclusive(openBotStage, roots.openBotRoot);
      openBotPublished = true;
    } catch (cause) {
      try {
        await rename(roots.userDataRoot, userStage);
        userPublished = false;
      } catch (rollbackCause) {
        throw new ServerMigrationSnapshotError(
          `OpenBot data publication failed and rollback could not restore the staged user data at ${userStage}.`,
          { cause: new AggregateError([cause, rollbackCause]) },
        );
      }
      throw cause;
    }
    await writeRecoveryJournal(recoveryJournal, { ...recoveryData, phase: "complete" });
    await rm(join(roots.openBotRoot, IMPORT_RECOVERY_FILE), { force: true });
    await rm(join(roots.userDataRoot, IMPORT_RECOVERY_FILE), { force: true });
    await rm(userStage, { recursive: true, force: true });
    await rm(openBotStage, { recursive: true, force: true });
    await rm(recoveryJournal, { force: true });
    return {
      userDataRoot: roots.userDataRoot,
      openBotRoot: roots.openBotRoot,
      manifest,
      managedAttachmentPathsRebased: true,
    };
  } catch (cause) {
    // If rollback itself failed, preserve the remaining stage for recovery instead of deleting it.
    if (!publicationStarted && !userPublished && !openBotPublished) {
      await rm(userStage, { recursive: true, force: true }).catch(() => undefined);
      if (openBotStage) await rm(openBotStage, { recursive: true, force: true }).catch(() => undefined);
    }
    if (publicationStarted && !userPublished && !openBotPublished) {
      throw new ServerMigrationSnapshotError(
        `Import publication failed. Recovery data remains at ${userStage}${openBotStage ? ` and ${openBotStage}` : ""}.`,
        { cause },
      );
    }
    if (cause instanceof ServerMigrationSnapshotError) throw cause;
    throw new ServerMigrationSnapshotError("The verified server snapshot could not be imported.", { cause });
  }
}

/** Verify a received snapshot before any files are installed or account directory is changed. */
export async function verifyServerMigrationSnapshot(snapshotPath: string): Promise<ServerMigrationSnapshotManifest> {
  const rootPath = resolve(snapshotPath);
  const rootStats = await lstat(rootPath).catch((cause) => {
    throw new ServerMigrationSnapshotError("The snapshot directory is missing or unreadable.", { cause });
  });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new ServerMigrationSnapshotError("The snapshot path must be a real directory.");
  }

  const manifestPath = join(rootPath, SNAPSHOT_MANIFEST_FILE);
  const manifestStats = await lstat(manifestPath).catch((cause) => {
    throw new ServerMigrationSnapshotError("The snapshot manifest is missing or unreadable.", { cause });
  });
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
    throw new ServerMigrationSnapshotError("The snapshot manifest must be a regular file.");
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    throw new ServerMigrationSnapshotError("The snapshot manifest is invalid.", { cause });
  }
  const decoded = decodeManifest(manifest);
  const expectedFiles = new Map(decoded.files.map((file) => [file.path, file]));
  const expectedDirectories = new Set(decoded.directories);
  const foundFiles = new Set<string>();
  const foundDirectories = new Set<string>();
  const actualRoot = await realpath(rootPath);
  await walkSnapshot(actualRoot, "", foundDirectories, foundFiles);

  if (!sameStringSet(expectedDirectories, foundDirectories) || !sameStringSet(expectedFiles.keys(), foundFiles)) {
    throw new ServerMigrationSnapshotError("The snapshot file list does not match its manifest.");
  }

  let totalBytes = 0;
  for (const [relativePath, expected] of expectedFiles) {
    const filePath = snapshotPathFromRelative(actualRoot, relativePath);
    const actual = await hashFile(filePath);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new ServerMigrationSnapshotError(`Snapshot integrity check failed for ${relativePath}.`);
    }
    totalBytes += actual.bytes;
  }
  if (totalBytes !== decoded.totalBytes) {
    throw new ServerMigrationSnapshotError("The snapshot total byte count does not match its manifest.");
  }
  return decoded;
}

function assertImportManifestAllowlist(manifest: ServerMigrationSnapshotManifest): void {
  const allowedFiles = new Set([
    "user-data/openbot.db",
    "user-data/mailbox.json",
    "user-data/bots.json",
    "user-data/openbot-sidebar-layout-v1.json",
  ]);
  for (const file of manifest.files) {
    if (allowedFiles.has(file.path)) continue;
    if (isAllowedAssetPath(file.path) || isAllowedWorkspacePath(file.path)) continue;
    throw new ServerMigrationSnapshotError(`The snapshot includes a non-migratable file: ${file.path}.`);
  }
  if (!manifest.files.some((file) => file.path === "user-data/openbot.db")) {
    throw new ServerMigrationSnapshotError("The snapshot does not contain the required OpenBot database.");
  }
  if (!manifest.files.some((file) => file.path === `home/OpenBot/${AGENT_DATABASE_RELATIVE_PATH}`)) {
    throw new ServerMigrationSnapshotError("The snapshot does not contain the required shared agent database.");
  }
  for (const directory of manifest.directories) {
    if (
      ["user-data", "home", "home/OpenBot"].includes(directory) ||
      isAllowedAssetDirectory(directory) ||
      isAllowedWorkspacePath(directory)
    ) {
      continue;
    }
    throw new ServerMigrationSnapshotError(`The snapshot includes a non-migratable directory: ${directory}.`);
  }
}

async function resolveFreshDestinationRoots(
  options: ImportServerMigrationSnapshotOptions,
  snapshotRoot: string,
): Promise<SourceRoots> {
  const userDataRoot = await resolveFreshDestination(options.userDataRoot, "userDataRoot");
  const openBotRoot = await resolveFreshDestination(options.openBotRoot, "openBotRoot");
  if (pathsOverlap(userDataRoot, openBotRoot)) {
    throw new ServerMigrationSnapshotError("The destination data and workspace roots must be separate.");
  }
  if (pathsOverlap(userDataRoot, snapshotRoot) || pathsOverlap(openBotRoot, snapshotRoot)) {
    throw new ServerMigrationSnapshotError("The snapshot cannot overlap an import destination.");
  }
  return { userDataRoot, openBotRoot };
}

function resolveAttachmentOpenBotRoot(
  options: ImportServerMigrationSnapshotOptions,
  roots: SourceRoots,
  snapshotRoot: string,
): string {
  const attachmentOpenBotRoot = options.attachmentOpenBotRoot ?? roots.openBotRoot;
  if (!isAbsolute(attachmentOpenBotRoot)) {
    throw new ServerMigrationSnapshotError("The attachment workspace root must be an absolute path.");
  }
  const resolved = resolve(attachmentOpenBotRoot);
  if (
    pathsOverlap(resolved, roots.userDataRoot) ||
    (resolved !== roots.openBotRoot && pathsOverlap(resolved, roots.openBotRoot)) ||
    pathsOverlap(resolved, snapshotRoot)
  ) {
    throw new ServerMigrationSnapshotError("The attachment workspace root overlaps migration data.");
  }
  return resolved;
}

/** Roll back a user root left published by a process crash between the two root publications. */
async function recoverInterruptedImport(options: ImportServerMigrationSnapshotOptions): Promise<void> {
  if (!isAbsolute(options.userDataRoot) || !isAbsolute(options.openBotRoot)) return;
  const userDataRoot = await canonicalizePotentialPath(resolve(options.userDataRoot));
  const openBotRoot = await canonicalizePotentialPath(resolve(options.openBotRoot));
  const journalPath = recoveryJournalPath(userDataRoot);
  const userMarkerPath = join(userDataRoot, IMPORT_RECOVERY_FILE);
  const openBotMarkerPath = join(openBotRoot, IMPORT_RECOVERY_FILE);
  const markerPath = (await lstatOptional(journalPath))
    ? journalPath
    : (await lstatOptional(userMarkerPath))
      ? userMarkerPath
      : openBotMarkerPath;
  const markerInfo = await lstatOptional(markerPath);
  if (!markerInfo) return;
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
    throw new ServerMigrationSnapshotError("An interrupted import recovery marker is invalid.");
  }
  let record: unknown;
  try {
    record = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (cause) {
    throw new ServerMigrationSnapshotError("An interrupted import recovery marker is unreadable.", { cause });
  }
  const decoded = importRecoverySchema.safeParse(record);
  if (!decoded.success) {
    throw new ServerMigrationSnapshotError("An interrupted import recovery marker is invalid.");
  }
  const candidate = decoded.data;
  const userStage = candidate.userStage;
  const openBotStage = candidate.openBotStage;
  if (
    candidate.userDataRoot !== userDataRoot ||
    candidate.openBotRoot !== openBotRoot ||
    typeof userStage !== "string" ||
    typeof openBotStage !== "string" ||
    dirname(userStage) !== dirname(userDataRoot) ||
    dirname(openBotStage) !== dirname(openBotRoot) ||
    !basename(userStage).startsWith(`.${basename(userDataRoot)}.migration-stage-`) ||
    !basename(openBotStage).startsWith(`.${basename(openBotRoot)}.migration-stage-`)
  ) {
    throw new ServerMigrationSnapshotError("An interrupted import recovery marker does not match these destinations.");
  }
  if (candidate.phase === "complete") {
    await rm(userMarkerPath, { force: true });
    await rm(openBotMarkerPath, { force: true });
    await rm(userStage, { recursive: true, force: true });
    await rm(openBotStage, { recursive: true, force: true });
    await rm(journalPath, { force: true });
    return;
  }
  if (await lstatOptional(userDataRoot)) {
    if (!(await hasMatchingRecoveryMarker(userDataRoot, candidate))) {
      throw new ServerMigrationSnapshotError("An interrupted import destination cannot be proven safe to roll back.");
    }
    await restorePublishedDirectory(userDataRoot, userStage);
  }
  if (await lstatOptional(openBotRoot)) {
    if (!(await hasMatchingRecoveryMarker(openBotRoot, candidate))) {
      throw new ServerMigrationSnapshotError("An interrupted import destination cannot be proven safe to roll back.");
    }
    await restorePublishedDirectory(openBotRoot, openBotStage);
  }
  await rm(userStage, { recursive: true, force: true });
  await rm(openBotStage, { recursive: true, force: true });
  await rm(journalPath, { force: true });
}

function recoveryJournalPath(userDataRoot: string): string {
  return join(dirname(userDataRoot), `.${basename(userDataRoot)}.openbot-migration-recovery.json`);
}

async function writeRecoveryJournal(path: string, data: z.infer<typeof importRecoverySchema>): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

async function restorePublishedDirectory(publishedPath: string, stagePath: string): Promise<void> {
  await mkdir(stagePath, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(publishedPath)) {
    await rename(join(publishedPath, entry), join(stagePath, entry));
  }
  await rm(publishedPath, { recursive: true, force: true });
}

async function hasMatchingRecoveryMarker(
  root: string,
  expected: z.infer<typeof importRecoverySchema>,
): Promise<boolean> {
  const path = join(root, IMPORT_RECOVERY_FILE);
  const info = await lstatOptional(path);
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  try {
    const parsed = importRecoverySchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    return (
      parsed.success &&
      parsed.data.userDataRoot === expected.userDataRoot &&
      parsed.data.openBotRoot === expected.openBotRoot &&
      parsed.data.userStage === expected.userStage &&
      parsed.data.openBotStage === expected.openBotStage
    );
  } catch {
    return false;
  }
}

async function resolveFreshDestination(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new ServerMigrationSnapshotError(`${label} must be an absolute path.`);
  const resolved = resolve(path);
  const name = basename(resolved);
  if (!name || name === "." || name === ".." || name === sep) {
    throw new ServerMigrationSnapshotError(`${label} is not a valid new directory path.`);
  }
  const parent = dirname(resolved);
  const parentInfo = await lstat(parent).catch((cause) => {
    throw new ServerMigrationSnapshotError(`${label}'s parent must already exist.`, { cause });
  });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new ServerMigrationSnapshotError(`${label}'s parent must be a real directory.`);
  }
  const root = join(await realpath(parent), name);
  await assertPathMissing(root, label);
  return root;
}

async function assertPathMissing(path: string, label: string): Promise<void> {
  if (await lstatOptional(path)) throw new ServerMigrationSnapshotError(`${label} must not already exist.`);
}

async function createSiblingStage(destinationRoot: string): Promise<string> {
  return mkdtemp(join(dirname(destinationRoot), `.${basename(destinationRoot)}.migration-stage-${randomUUID()}-`));
}

async function materializeSnapshot(
  snapshotRoot: string,
  manifest: ServerMigrationSnapshotManifest,
  userDataStage: string,
  openBotStage: string,
): Promise<void> {
  for (const directory of manifest.directories) {
    const target = destinationPathForManifestPath(directory, userDataStage, openBotStage);
    if (!target) continue;
    await mkdir(target, { recursive: true, mode: 0o700 });
    await chmod(target, 0o700);
  }
  for (const file of manifest.files) {
    const target = destinationPathForManifestPath(file.path, userDataStage, openBotStage);
    if (!target) throw new ServerMigrationSnapshotError(`A snapshot file has no destination: ${file.path}.`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const source = snapshotPathFromRelative(snapshotRoot, file.path);
    const copied = await copyAndHashRegularFile(source, target, snapshotRoot);
    if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) {
      throw new ServerMigrationSnapshotError(`Snapshot content changed while importing ${file.path}.`);
    }
  }
}

function destinationPathForManifestPath(path: string, userDataStage: string, openBotStage: string): string | null {
  if (path === "user-data" || path === "home" || path === "home/OpenBot") return null;
  if (path.startsWith("user-data/")) {
    return resolveStagedPath(userDataStage, path.slice("user-data/".length));
  }
  if (path.startsWith("home/OpenBot/")) {
    return resolveStagedPath(openBotStage, path.slice("home/OpenBot/".length));
  }
  throw new ServerMigrationSnapshotError("A snapshot path does not map to one of the explicit destination roots.");
}

function resolveStagedPath(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) {
    throw new ServerMigrationSnapshotError("A snapshot entry has an invalid relative path.");
  }
  const target = resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, target)) throw new ServerMigrationSnapshotError("A snapshot entry escaped its staging root.");
  return target;
}

async function rebaseMailboxFile(path: string, openBotRoot: string): Promise<Map<string, boolean>> {
  const references = new Map<string, boolean>();
  if (!(await lstatOptional(path))) return references;
  let state: unknown;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new ServerMigrationSnapshotError("The staged mailbox state is invalid.", { cause });
  }
  transformAttachmentJson(state, (portablePath, deleted) => {
    const restored = fromPortableOpenBotPath(portablePath, openBotRoot);
    rememberAttachmentPath(references, restored, deleted);
    return restored;
  });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return references;
}

async function validateSqliteIntegrity(path: string, label: string): Promise<void> {
  const info = await lstatOptional(path);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new ServerMigrationSnapshotError(`The imported SQLite database is missing or invalid: ${label}.`);
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    const result = db.prepare("PRAGMA integrity_check").all();
    if (result.length !== 1 || !isDynamicRecord(result[0]) || Object.values(result[0])[0] !== "ok") {
      throw new ServerMigrationSnapshotError(`SQLite integrity_check failed for ${label}.`);
    }
  } catch (cause) {
    if (cause instanceof ServerMigrationSnapshotError) throw cause;
    throw new ServerMigrationSnapshotError(`SQLite integrity_check failed for ${label}.`, { cause });
  } finally {
    db.close();
  }
}

async function validateImportedAttachmentReferences(
  references: Map<string, boolean>,
  openBotStage: string,
  destinationOpenBotRoot: string,
  missingAttachmentPaths: readonly string[] = [],
): Promise<void> {
  const explicitlyMissing = new Set(missingAttachmentPaths.map(relativePathFromPortableMarker));
  if (explicitlyMissing.size !== missingAttachmentPaths.length) {
    throw new ServerMigrationSnapshotError("The snapshot lists a missing attachment more than once.");
  }
  for (const relativePath of explicitlyMissing) {
    const absolutePath = resolve(destinationOpenBotRoot, ...relativePath.split("/"));
    if (!references.has(absolutePath)) {
      throw new ServerMigrationSnapshotError("The snapshot lists a missing attachment that is not referenced.");
    }
    if (await lstatOptional(resolveStagedPath(openBotStage, relativePath))) {
      throw new ServerMigrationSnapshotError("The snapshot lists an attachment as missing but includes its file.");
    }
  }
  for (const [absolutePath, mayBeMissing] of references) {
    const relativePath = relative(destinationOpenBotRoot, absolutePath).split(sep).join("/");
    if (!isIncludedOpenBotRelativePath(relativePath)) {
      throw new ServerMigrationSnapshotError(
        "An attachment reference could not be mapped into the imported workspace.",
      );
    }
    const target = resolveStagedPath(openBotStage, relativePath);
    const info = await lstatOptional(target);
    if (!info && (mayBeMissing || explicitlyMissing.has(relativePath))) continue;
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new ServerMigrationSnapshotError(
        `An attachment reference does not have an imported file: ${relativePath}.`,
      );
    }
  }
}

async function validatePortableAttachmentReferences(snapshotRoot: string, builder: SnapshotBuilder): Promise<string[]> {
  const files = new Set(builder.files.map((file) => file.path));
  const missing: string[] = [];
  for (const [portablePath, mayBeMissing] of builder.attachmentPaths) {
    const relativePath = relativePathFromPortableMarker(portablePath);
    if (files.has(`home/OpenBot/${relativePath}`) || mayBeMissing) continue;
    missing.push(portablePath);
  }
  // Both databases and JSON files must be regular staging files; verification catches links and
  // extra entries later, while this confirms the output roots used by path markers are present.
  if (!(await lstatOptional(join(snapshotRoot, "home/OpenBot")))) {
    throw new ServerMigrationSnapshotError("The portable attachment workspace is missing from the snapshot.");
  }
  return missing.sort((left, right) => left.localeCompare(right));
}

function isAllowedWorkspacePath(path: string): boolean {
  return ["home/OpenBot/Agents", "home/OpenBot/Bots", "home/OpenBot/Shared"].some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function isAllowedAssetDirectory(path: string): boolean {
  return (
    path === "user-data/avatars" ||
    path === "user-data/avatars/agents" ||
    path.startsWith("user-data/avatars/agents/") ||
    path === "user-data/openbot-team-server-v1.json.assets" ||
    path === "user-data/openbot-team-server-v1.json.assets/logo" ||
    path.startsWith("user-data/openbot-team-server-v1.json.assets/logo/") ||
    path === "user-data/openbot-team-server-v2.json.assets" ||
    path === "user-data/openbot-team-server-v2.json.assets/logo" ||
    path.startsWith("user-data/openbot-team-server-v2.json.assets/logo/")
  );
}

function isAllowedAssetPath(path: string): boolean {
  const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
  return (
    isAllowedAssetDirectory(path.slice(0, path.lastIndexOf("/"))) && imageExtensions.has(extname(path).toLowerCase())
  );
}

async function resolveSourceRoots(options: ServerMigrationSnapshotOptions): Promise<SourceRoots> {
  const userDataRoot = await resolveDirectory(options.userDataRoot, "userDataRoot");
  const openBotRoot = await resolveDirectory(options.openBotRoot, "openBotRoot");
  if (pathsOverlap(userDataRoot, openBotRoot)) {
    throw new ServerMigrationSnapshotError("The user data and workspace roots must be separate directories.");
  }
  return { userDataRoot, openBotRoot };
}

async function resolveDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new ServerMigrationSnapshotError(`${label} must be an absolute path.`);
  const resolved = resolve(path);
  const info = await lstat(resolved).catch((cause) => {
    throw new ServerMigrationSnapshotError(`${label} must exist as a real directory.`, { cause });
  });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ServerMigrationSnapshotError(`${label} must be a real directory.`);
  }
  return realpath(resolved);
}

async function resolveDestination(path: string, roots: SourceRoots): Promise<string> {
  if (!isAbsolute(path)) throw new ServerMigrationSnapshotError("The snapshot destination must be absolute.");
  const resolved = resolve(path);
  const name = basename(resolved);
  if (!name || name === "." || name === "..") {
    throw new ServerMigrationSnapshotError("The snapshot destination path is invalid.");
  }
  const parent = dirname(resolved);
  const anticipatedDestination = await canonicalizePotentialPath(resolved);
  if (
    pathsOverlap(anticipatedDestination, roots.userDataRoot) ||
    pathsOverlap(anticipatedDestination, roots.openBotRoot)
  ) {
    throw new ServerMigrationSnapshotError("The snapshot destination cannot overlap a source data root.");
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(parent);
  const destination = join(canonicalParent, name);
  if (destination !== anticipatedDestination) {
    throw new ServerMigrationSnapshotError("The snapshot destination parent changed while it was being prepared.");
  }
  if (await lstatOptional(destination)) {
    throw new ServerMigrationSnapshotError("The snapshot destination already exists.");
  }
  return destination;
}

/** Resolve a path through its nearest existing ancestor without creating missing directories. */
async function canonicalizePotentialPath(path: string): Promise<string> {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const info = await lstat(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new ServerMigrationSnapshotError("The snapshot destination parent must be a real directory.");
      }
      return join(await realpath(ancestor), ...missing.reverse());
    } catch (cause) {
      if (cause instanceof ServerMigrationSnapshotError) throw cause;
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") {
        throw new ServerMigrationSnapshotError("The snapshot destination parent could not be resolved.", { cause });
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw new ServerMigrationSnapshotError("The snapshot destination parent could not be resolved.", { cause });
      }
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Claim the target with mkdir (which fails if it appeared after validation), then move staged entries in. */
async function publishDirectoryExclusive(stagePath: string, destinationPath: string): Promise<void> {
  await mkdir(destinationPath, { mode: 0o700 });
  const moved: string[] = [];
  try {
    const entries = await readdir(stagePath);
    entries.sort((left, right) => Number(right === IMPORT_RECOVERY_FILE) - Number(left === IMPORT_RECOVERY_FILE));
    for (const entry of entries) {
      await rename(join(stagePath, entry), join(destinationPath, entry));
      moved.push(entry);
    }
  } catch (cause) {
    for (const entry of moved.reverse()) {
      await rename(join(destinationPath, entry), join(stagePath, entry)).catch(() => undefined);
    }
    await rm(destinationPath, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

async function copyOptionalFile(
  root: string,
  relativePath: string,
  builder: SnapshotBuilder,
  outputRelativePath: string,
): Promise<void> {
  const sourcePath = await safeSourcePath(root, relativePath);
  const info = await lstatOptional(sourcePath);
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ServerMigrationSnapshotError(`Included source path is not a regular file: ${relativePath}.`);
  }
  await makeOutputParent(builder, outputRelativePath);
  const outputPath = snapshotPathFromRelative(builder.stagePath, outputRelativePath);
  const result = await copyAndHashRegularFile(sourcePath, outputPath, root);
  builder.files.push({ path: outputRelativePath, ...result });
}

async function snapshotMailboxState(
  root: string,
  relativePath: string,
  builder: SnapshotBuilder,
  attachmentSourceRoot: string,
): Promise<void> {
  await copyOptionalFile(root, relativePath, builder, `user-data/${relativePath}`);
  const outputRelativePath = `user-data/${relativePath}`;
  const outputPath = snapshotPathFromRelative(builder.stagePath, outputRelativePath);
  if (!(await lstatOptional(outputPath))) return;

  let state: unknown;
  try {
    state = JSON.parse(await readFile(outputPath, "utf8"));
  } catch (cause) {
    throw new ServerMigrationSnapshotError("The mailbox state cannot be safely migrated.", { cause });
  }
  if (isDynamicRecord(state) && Array.isArray(state.drafts)) Object.assign(state, { drafts: [] });
  transformAttachmentJson(state, (path, deleted) => {
    const portablePath = toPortableOpenBotPath(path, attachmentSourceRoot);
    rememberAttachmentPath(builder.attachmentPaths, portablePath, deleted);
    return portablePath;
  });
  await writeFile(outputPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await replaceFileHash(builder, outputPath, outputRelativePath);
}

async function copyOptionalTree(
  root: string,
  relativePath: string,
  builder: SnapshotBuilder,
  outputRelativePath: string,
  options?: WalkOptions,
): Promise<void> {
  const sourcePath = await safeSourcePath(root, relativePath);
  const info = await lstatOptional(sourcePath);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ServerMigrationSnapshotError(`Included source path is not a real directory: ${relativePath}.`);
  }
  await copyDirectoryTree(root, sourcePath, relativePath, outputRelativePath, builder, options);
}

async function copyDirectoryTree(
  sourceRoot: string,
  sourcePath: string,
  sourceRelativePath: string,
  outputRelativePath: string,
  builder: SnapshotBuilder,
  options?: WalkOptions,
): Promise<void> {
  const info = await lstat(sourcePath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ServerMigrationSnapshotError(
      `An included directory changed type during snapshot: ${sourceRelativePath}.`,
    );
  }
  await makeOutputDirectory(builder, outputRelativePath);
  const entries = await readdir(sourcePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (
      !entry.name ||
      entry.name === "." ||
      entry.name === ".." ||
      entry.name.includes("/") ||
      entry.name.includes("\\")
    ) {
      throw new ServerMigrationSnapshotError("A source directory contains an invalid entry name.");
    }
    const childSourceRelative = `${sourceRelativePath}/${entry.name}`;
    if (options?.skipRelativePaths?.has(childSourceRelative)) continue;
    const childSourcePath = join(sourcePath, entry.name);
    const childOutputRelative = `${outputRelativePath}/${entry.name}`;
    const childInfo = await lstat(childSourcePath);
    if (childInfo.isSymbolicLink()) {
      throw new ServerMigrationSnapshotError(
        `Symbolic links are not allowed in migration data: ${childSourceRelative}.`,
      );
    }
    if (childInfo.isDirectory()) {
      await copyDirectoryTree(sourceRoot, childSourcePath, childSourceRelative, childOutputRelative, builder, options);
      continue;
    }
    if (!childInfo.isFile()) {
      throw new ServerMigrationSnapshotError(
        `Special files are not allowed in migration data: ${childSourceRelative}.`,
      );
    }
    if (
      outputRelativePath.startsWith("user-data/") &&
      isAllowedAssetDirectory(dirname(childOutputRelative).split(sep).join("/")) &&
      !isAllowedAssetPath(childOutputRelative)
    ) {
      continue;
    }
    await makeOutputParent(builder, childOutputRelative);
    const targetPath = snapshotPathFromRelative(builder.stagePath, childOutputRelative);
    const result = await copyAndHashRegularFile(childSourcePath, targetPath, sourceRoot);
    builder.files.push({ path: childOutputRelative, ...result });
  }
}

async function snapshotOptionalSqlite(
  root: string,
  relativePath: string,
  builder: SnapshotBuilder,
  outputRelativePath: string,
  attachmentSourceRoot?: string,
  rewrite?: (databasePath: string) => Promise<void> | void,
): Promise<void> {
  const sourcePath = await safeSourcePath(root, relativePath);
  const info = await lstatOptional(sourcePath);
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ServerMigrationSnapshotError(`SQLite source is not a regular file: ${relativePath}.`);
  }
  if ((await realpath(sourcePath)) !== sourcePath) {
    throw new ServerMigrationSnapshotError(`SQLite source path resolves through a symbolic link: ${relativePath}.`);
  }
  await makeOutputParent(builder, outputRelativePath);
  const targetPath = snapshotPathFromRelative(builder.stagePath, outputRelativePath);
  const sourceBefore = await lstat(sourcePath, { bigint: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    source.prepare("VACUUM INTO ?").run(targetPath);
  } catch (cause) {
    throw new ServerMigrationSnapshotError(`SQLite could not create a consistent snapshot of ${relativePath}.`, {
      cause,
    });
  } finally {
    source.close();
  }
  if (attachmentSourceRoot)
    portableizeDatabaseAttachmentPaths(targetPath, attachmentSourceRoot, builder.attachmentPaths);
  if (rewrite) {
    try {
      await rewrite(targetPath);
    } catch (cause) {
      throw new ServerMigrationSnapshotError(`The staged copy of ${relativePath} could not be rewritten.`, { cause });
    }
  }
  const sourceAfter = await lstat(sourcePath, { bigint: true });
  if (!sameFileVersion(sourceBefore, sourceAfter)) {
    throw new ServerMigrationSnapshotError(`SQLite source changed while snapshotting ${relativePath}.`);
  }

  const snapshot = new DatabaseSync(targetPath, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    const integrity = snapshot.prepare("PRAGMA integrity_check").get();
    if (!integrity || Object.values(integrity)[0] !== "ok") {
      throw new ServerMigrationSnapshotError(`SQLite snapshot integrity check failed for ${relativePath}.`);
    }
  } finally {
    snapshot.close();
  }
  await chmod(targetPath, 0o600);
  const result = await hashFile(targetPath);
  builder.files.push({ path: outputRelativePath, ...result });
}

type AttachmentPathMode = "portableize" | "restore";

function portableizeDatabaseAttachmentPaths(
  databasePath: string,
  sourceRoot: string,
  references: Map<string, boolean>,
): void {
  rewriteDatabaseAttachmentPaths(databasePath, "portableize", sourceRoot, references);
}

function restoreDatabaseAttachmentPaths(databasePath: string, destinationRoot: string): Map<string, boolean> {
  return rewriteDatabaseAttachmentPaths(databasePath, "restore", destinationRoot);
}

function rewriteDatabaseAttachmentPaths(
  databasePath: string,
  mode: AttachmentPathMode,
  openBotRoot: string,
  references = new Map<string, boolean>(),
): Map<string, boolean> {
  const db = new DatabaseSync(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    // These are staged databases. Erase deleted MCP secrets and transient draft metadata from
    // pages, then compact the file so old content cannot remain in freelist pages.
    db.exec("PRAGMA secure_delete = ON");
    db.exec("BEGIN IMMEDIATE");
    try {
      // MCP configs are stored in this database, not in the encrypted OAuth file. Their command
      // arguments, environment, URL, and headers may contain credentials, so they never migrate.
      if (sqliteTableExists(db, "projection_mcp_servers")) db.exec("DELETE FROM projection_mcp_servers");

      if (sqliteTableExists(db, "projection_attachments")) {
        // Draft uploads are transient composer state under the excluded attachment-drafts tree.
        db.exec("DELETE FROM projection_attachments WHERE owner_kind = 'draft'");
        const rows = db
          .prepare("SELECT attachment_id, owner_kind, path, metadata_json FROM projection_attachments")
          .all();
        const update = db.prepare("UPDATE projection_attachments SET path = ? WHERE attachment_id = ?");
        for (const row of rows) {
          if (!isDynamicRecord(row)) throw new ServerMigrationSnapshotError("Attachment rows are invalid.");
          const path = typeof row.path === "string" ? row.path : "";
          if (!path) continue;
          const metadata = parseJsonRecord(row.metadata_json, "attachment metadata");
          const deleted = typeof metadata.deletedAt === "string";
          const next = transformAttachmentPath(path, mode, openBotRoot);
          rememberAttachmentPath(references, next, deleted);
          if (next !== path) update.run(next, String(row.attachment_id));
        }
      }

      if (sqliteTableExists(db, "file_deletion_outbox")) {
        const rows = db.prepare("SELECT id, path FROM file_deletion_outbox").all();
        const update = db.prepare("UPDATE file_deletion_outbox SET path = ? WHERE id = ?");
        for (const row of rows) {
          if (!isDynamicRecord(row)) throw new ServerMigrationSnapshotError("File deletion rows are invalid.");
          if (typeof row.path !== "string" || !row.path) continue;
          const next = transformAttachmentPath(row.path, mode, openBotRoot);
          // Deletion jobs may already refer to a file that has been removed, but must never retain
          // a path into the source host after migration.
          rememberAttachmentPath(references, next, true);
          if (next !== row.path) update.run(next, String(row.id));
        }
      }

      rewriteJsonAttachmentColumns(db, mode, openBotRoot, references);
      db.exec("COMMIT");
      db.exec("VACUUM");
    } catch (cause) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw cause;
    }
  } catch (cause) {
    if (cause instanceof ServerMigrationSnapshotError) throw cause;
    throw new ServerMigrationSnapshotError("Attachment paths in the migration database could not be rewritten.", {
      cause,
    });
  } finally {
    db.close();
  }
  return references;
}

function rewriteJsonAttachmentColumns(
  db: DatabaseSync,
  mode: AttachmentPathMode,
  openBotRoot: string,
  references: Map<string, boolean>,
): void {
  const tableRows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  for (const tableRow of tableRows) {
    if (!isDynamicRecord(tableRow) || typeof tableRow.name !== "string") {
      throw new ServerMigrationSnapshotError("A migration database table definition is invalid.");
    }
    const table = { name: tableRow.name, sql: typeof tableRow.sql === "string" ? tableRow.sql : null };
    const tableName = quoteSqlIdentifier(table.name);
    const columnRows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const columns: Array<{ name: string; pk: number }> = [];
    for (const column of columnRows) {
      if (!isDynamicRecord(column) || typeof column.name !== "string" || typeof column.pk !== "number") {
        throw new ServerMigrationSnapshotError(`A migration database column definition is invalid: ${table.name}.`);
      }
      columns.push({ name: column.name, pk: column.pk });
    }
    const jsonColumns = columns.filter((column) => column.name.endsWith("_json"));
    if (jsonColumns.length === 0) continue;
    const primaryKey = columns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk);
    const usesRowId = !/\bWITHOUT\s+ROWID\b/iu.test(table.sql ?? "");
    if (!usesRowId && primaryKey.length === 0) {
      throw new ServerMigrationSnapshotError(`Cannot safely rewrite JSON in ${table.name}.`);
    }
    const keySelect = primaryKey.length
      ? primaryKey.map(
          (column, index) => `${quoteSqlIdentifier(column.name)} AS ${quoteSqlIdentifier(`__key_${index}`)}`,
        )
      : [`_rowid_ AS ${quoteSqlIdentifier("__key_0")}`];
    const keyWhere = primaryKey.length
      ? primaryKey.map((column) => `${quoteSqlIdentifier(column.name)} IS ?`).join(" AND ")
      : "_rowid_ IS ?";
    for (const column of jsonColumns) {
      const columnName = quoteSqlIdentifier(column.name);
      const rows = db
        .prepare(
          `SELECT ${[...keySelect, `${columnName} AS ${quoteSqlIdentifier("__json_value")}`].join(", ")}
           FROM ${tableName} WHERE ${columnName} IS NOT NULL`,
        )
        .all();
      const update = db.prepare(`UPDATE ${tableName} SET ${columnName} = ? WHERE ${keyWhere}`);
      for (const row of rows) {
        if (!isDynamicRecord(row)) throw new ServerMigrationSnapshotError(`A row in ${table.name} is invalid.`);
        if (typeof row.__json_value !== "string") continue;
        let value: unknown;
        try {
          value = JSON.parse(row.__json_value);
        } catch (cause) {
          throw new ServerMigrationSnapshotError(`Cannot parse JSON in ${table.name}.${column.name}.`, { cause });
        }
        if (
          !transformAttachmentJson(value, (path, deleted) => {
            const next = transformAttachmentPath(path, mode, openBotRoot);
            rememberAttachmentPath(references, next, deleted);
            return next;
          })
        ) {
          continue;
        }
        const rawKeys = primaryKey.length ? primaryKey.map((_column, index) => row[`__key_${index}`]) : [row.__key_0];
        const keys: SQLInputValue[] = rawKeys.map((key) => {
          if (key === null || typeof key === "string" || typeof key === "number" || typeof key === "bigint") {
            return key;
          }
          if (key instanceof Uint8Array) return key;
          throw new ServerMigrationSnapshotError(`A row key in ${table.name} cannot be updated safely.`);
        });
        update.run(JSON.stringify(value), ...keys);
      }
    }
  }
}

function sqliteTableExists(db: DatabaseSync, tableName: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function parseJsonRecord(value: unknown, label: string): DynamicRecord {
  if (typeof value !== "string") throw new ServerMigrationSnapshotError(`The ${label} is invalid.`);
  try {
    const parsed = JSON.parse(value);
    if (isDynamicRecord(parsed)) return parsed;
  } catch (cause) {
    throw new ServerMigrationSnapshotError(`The ${label} is invalid.`, { cause });
  }
  throw new ServerMigrationSnapshotError(`The ${label} is invalid.`);
}

function transformAttachmentJson(value: unknown, transformPath: (path: string, deleted: boolean) => string): boolean {
  let changed = false;
  const visit = (current: unknown, parentKey = ""): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item, parentKey);
      return;
    }
    if (!isDynamicRecord(current)) return;

    const isAttachment =
      isStoredAttachmentRecord(current) ||
      ((parentKey === "attachments" || parentKey === "generatedAttachments") &&
        typeof current.id === "string" &&
        typeof current.name === "string" &&
        typeof current.path === "string");
    if (isAttachment && typeof current.path === "string" && current.path.length > 0) {
      const next = transformPath(current.path, typeof current.deletedAt === "string");
      if (next !== current.path) {
        Object.assign(current, { path: next });
        changed = true;
      }
    }
    for (const [key, child] of Object.entries(current)) {
      if (key !== "path") visit(child, key);
    }
  };
  visit(value);
  return changed;
}

function isStoredAttachmentRecord(value: DynamicRecord): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    typeof value.kind === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.sha256 === "string"
  );
}

function transformAttachmentPath(path: string, mode: AttachmentPathMode, openBotRoot: string): string {
  return mode === "portableize" ? toPortableOpenBotPath(path, openBotRoot) : fromPortableOpenBotPath(path, openBotRoot);
}

function toPortableOpenBotPath(path: string, openBotRoot: string): string {
  if (path.startsWith(PORTABLE_OPENBOT_PATH_PREFIX)) {
    throw new ServerMigrationSnapshotError("The source data already contains a migration path marker.");
  }
  if (!isAbsolute(path)) {
    throw new ServerMigrationSnapshotError("An attachment path is not absolute and cannot be safely migrated.");
  }
  const sourcePath = resolve(path);
  const relativePath = relative(openBotRoot, sourcePath).split(sep).join("/");
  if (!isIncludedOpenBotRelativePath(relativePath)) {
    throw new ServerMigrationSnapshotError("An attachment path points outside the included OpenBot data roots.");
  }
  return `${PORTABLE_OPENBOT_PATH_PREFIX}${relativePath}`;
}

function fromPortableOpenBotPath(path: string, openBotRoot: string): string {
  const relativePath = relativePathFromPortableMarker(path);
  const result = resolve(openBotRoot, ...relativePath.split("/"));
  if (!isWithin(openBotRoot, result)) {
    throw new ServerMigrationSnapshotError("A portable attachment path escaped the destination workspace.");
  }
  return result;
}

function relativePathFromPortableMarker(path: string): string {
  if (!path.startsWith(PORTABLE_OPENBOT_PATH_PREFIX)) {
    throw new ServerMigrationSnapshotError("An attachment reference is not a portable migration path.");
  }
  const relativePath = path.slice(PORTABLE_OPENBOT_PATH_PREFIX.length);
  if (relativePath.includes("\\") || relativePath.includes("\0") || !isIncludedOpenBotRelativePath(relativePath)) {
    throw new ServerMigrationSnapshotError("A portable attachment path is invalid or outside included data.");
  }
  return relativePath;
}

function isIncludedOpenBotRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return (
    segments.length > 1 &&
    ["Agents", "Bots", "Shared"].includes(segments[0] ?? "") &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function rememberAttachmentPath(references: Map<string, boolean>, path: string, mayBeMissing: boolean): void {
  const current = references.get(path);
  references.set(path, current === undefined ? mayBeMissing : current && mayBeMissing);
}

function mergeAttachmentReferences(target: Map<string, boolean>, source: Map<string, boolean>): void {
  for (const [path, mayBeMissing] of source) rememberAttachmentPath(target, path, mayBeMissing);
}

async function replaceFileHash(builder: SnapshotBuilder, path: string, relativePath: string): Promise<void> {
  const recordIndex = builder.files.findIndex((file) => file.path === relativePath);
  if (recordIndex < 0)
    throw new ServerMigrationSnapshotError("A transformed migration file is missing from its manifest.");
  builder.files[recordIndex] = { path: relativePath, ...(await hashFile(path)) };
}

async function rejectUnexpectedSqliteSidecars(databasePath: string): Promise<void> {
  const base = await lstatOptional(databasePath);
  const baseExists = Boolean(base);
  for (const sidecar of sidecarPaths(databasePath)) {
    const info = await lstatOptional(sidecar);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ServerMigrationSnapshotError("SQLite journal paths must be regular files, not links or special files.");
    }
    if (!baseExists) {
      throw new ServerMigrationSnapshotError("A SQLite journal exists without its database file.");
    }
  }
}

async function safeSourcePath(root: string, relativePath: string): Promise<string> {
  const normalized = relativePath.split(/[\\/]+/u);
  if (isAbsolute(relativePath) || normalized.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ServerMigrationSnapshotError("An included source path is invalid.");
  }
  let current = root;
  for (const segment of normalized) {
    current = join(current, segment);
    const info = await lstatOptional(current);
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw new ServerMigrationSnapshotError(`Symbolic links are not allowed in migration data: ${relativePath}.`);
    }
  }
  const path = resolve(root, ...normalized);
  if (!isWithin(root, path)) throw new ServerMigrationSnapshotError("An included source path escaped its data root.");
  return path;
}

async function copyAndHashRegularFile(
  sourcePath: string,
  targetPath: string,
  sourceRoot: string,
): Promise<{ bytes: number; sha256: string }> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const source = await open(sourcePath, constants.O_RDONLY | noFollow);
  let target: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile()) throw new ServerMigrationSnapshotError("A migration source changed type during copying.");
    const pathInfo = await lstat(sourcePath, { bigint: true });
    if (
      pathInfo.isSymbolicLink() ||
      !sameFileVersion(pathInfo, before) ||
      (await realpath(sourcePath)) !== sourcePath ||
      !isWithin(sourceRoot, sourcePath)
    ) {
      throw new ServerMigrationSnapshotError("A migration source changed while it was being opened.");
    }
    target = await open(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(128 * 1024);
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (!Number.isSafeInteger(bytes)) {
        throw new ServerMigrationSnapshotError("A file exceeds the supported byte-count range.");
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(chunk, written, bytesRead - written, null);
        if (result.bytesWritten === 0)
          throw new ServerMigrationSnapshotError("A snapshot file write made no progress.");
        written += result.bytesWritten;
      }
    }
    const after = await source.stat({ bigint: true });
    if (!sameFileVersion(before, after) || bytes !== Number(before.size)) {
      throw new ServerMigrationSnapshotError("A migration source changed while it was being copied.");
    }
    const executable = (before.mode & 0o100n) !== 0n;
    await target.chmod(executable ? 0o700 : 0o600);
    await target.sync();
    return { bytes, sha256: hash.digest("hex") };
  } catch (cause) {
    await rm(targetPath, { force: true }).catch(() => undefined);
    if (cause instanceof ServerMigrationSnapshotError) throw cause;
    throw new ServerMigrationSnapshotError("A migration data file could not be copied safely.", { cause });
  } finally {
    await Promise.all([source.close(), target?.close()]);
  }
}

async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile()) throw new ServerMigrationSnapshotError("A snapshot entry is not a regular file.");
    const pathInfo = await lstat(path, { bigint: true });
    if (pathInfo.isSymbolicLink() || !sameFileVersion(pathInfo, info)) {
      throw new ServerMigrationSnapshotError("A snapshot file changed while it was being verified.");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(128 * 1024);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (!Number.isSafeInteger(bytes)) throw new ServerMigrationSnapshotError("A snapshot file is too large.");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    if (!sameFileVersion(info, after) || bytes !== Number(info.size)) {
      throw new ServerMigrationSnapshotError("A snapshot file changed during verification.");
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

async function walkSnapshot(
  rootPath: string,
  relativePath: string,
  directories: Set<string>,
  files: Set<string>,
): Promise<void> {
  const currentPath = relativePath ? snapshotPathFromRelative(rootPath, relativePath) : rootPath;
  const info = await lstat(currentPath);
  if (info.isSymbolicLink()) throw new ServerMigrationSnapshotError("Snapshots cannot contain symbolic links.");
  if (info.isDirectory()) {
    if (relativePath) directories.add(relativePath);
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        !entry.name ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("/") ||
        entry.name.includes("\\")
      ) {
        throw new ServerMigrationSnapshotError("A snapshot contains an invalid entry name.");
      }
      const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (child === SNAPSHOT_MANIFEST_FILE) continue;
      await walkSnapshot(rootPath, child, directories, files);
    }
    return;
  }
  if (!info.isFile()) throw new ServerMigrationSnapshotError("Snapshots cannot contain special files.");
  if (relativePath !== SNAPSHOT_MANIFEST_FILE) files.add(relativePath);
}

function decodeManifest(value: unknown): ServerMigrationSnapshotManifest {
  const parsed = snapshotManifestSchema.safeParse(value);
  if (!parsed.success) throw new ServerMigrationSnapshotError("The snapshot manifest has an invalid shape.");
  const record = parsed.data;
  if (!Number.isSafeInteger(record.totalBytes)) {
    throw new ServerMigrationSnapshotError("The snapshot manifest has an invalid total byte count.");
  }
  const directories = record.directories.map((path) => decodeManifestPath(path));
  const files: ServerMigrationSnapshotFile[] = record.files.map((file) => ({
    path: decodeManifestPath(file.path),
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  const missingAttachmentPaths = record.missingAttachmentPaths.map((path) => {
    const relativePath = relativePathFromPortableMarker(path);
    if (path !== `${PORTABLE_OPENBOT_PATH_PREFIX}${relativePath}`) {
      throw new ServerMigrationSnapshotError("The snapshot manifest contains a non-canonical missing attachment path.");
    }
    return path;
  });
  const directorySet = new Set(directories);
  const fileSet = new Set(files.map((file) => file.path));
  const missingAttachmentSet = new Set(missingAttachmentPaths);
  if (directorySet.size !== directories.length || fileSet.size !== files.length) {
    throw new ServerMigrationSnapshotError("The snapshot manifest contains duplicate paths.");
  }
  if (missingAttachmentSet.size !== missingAttachmentPaths.length) {
    throw new ServerMigrationSnapshotError("The snapshot manifest lists a missing attachment more than once.");
  }
  for (const missingPath of missingAttachmentPaths) {
    const relativePath = relativePathFromPortableMarker(missingPath);
    if (fileSet.has(`home/OpenBot/${relativePath}`)) {
      throw new ServerMigrationSnapshotError("The snapshot manifest marks an included attachment as missing.");
    }
  }
  for (const file of files) {
    if (directorySet.has(file.path))
      throw new ServerMigrationSnapshotError("A snapshot path cannot be both a file and a directory.");
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(total) || total !== record.totalBytes) {
    throw new ServerMigrationSnapshotError("The snapshot manifest has an invalid total byte count.");
  }
  return {
    version: SERVER_MIGRATION_SNAPSHOT_VERSION,
    createdAt: record.createdAt,
    directories,
    files,
    ...(missingAttachmentSet.size > 0
      ? { missingAttachmentPaths: [...missingAttachmentSet].sort((left, right) => left.localeCompare(right)) }
      : {}),
    totalBytes: total,
  };
}

function decodeManifestPath(value: string): string {
  if (value.includes("\\") || value.includes("\0")) {
    throw new ServerMigrationSnapshotError("The snapshot manifest contains an invalid path.");
  }
  if (
    (!MANIFEST_ROOT_PATHS.has(value) && !MANIFEST_PATH_PREFIXES.some((prefix) => value.startsWith(prefix))) ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    resolveSnapshotString(value) !== value
  ) {
    throw new ServerMigrationSnapshotError("The snapshot manifest contains a path outside the data allowlist.");
  }
  return value;
}

function resolveSnapshotString(path: string): string {
  return relative(".", resolve(".", ...path.split("/")))
    .split(sep)
    .join("/");
}

function snapshotPathFromRelative(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new ServerMigrationSnapshotError("An absolute snapshot path is not allowed.");
  const result = resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, result)) throw new ServerMigrationSnapshotError("A snapshot path escaped its root.");
  return result;
}

async function makeOutputParent(builder: SnapshotBuilder, relativePath: string): Promise<void> {
  const parent = dirname(relativePath).split(sep).join("/");
  if (parent === ".") return;
  const segments = parent.split("/");
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    await makeOutputDirectory(builder, current);
  }
}

async function makeOutputDirectory(builder: SnapshotBuilder, relativePath: string): Promise<void> {
  const path = snapshotPathFromRelative(builder.stagePath, relativePath);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  builder.directories.add(relativePath);
}

function sameFileVersion(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sidecarPaths(path: string): string[] {
  return SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${path}${suffix}`);
}

async function lstatOptional(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
}

function isMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function pathsOverlap(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

function sameStringSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}
