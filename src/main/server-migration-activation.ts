import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";

const JOURNAL_VERSION = 1;
const JOURNAL_SUFFIX = ".openbot-server-migration-activation.json";
const MAX_JOURNAL_BYTES = 64 * 1024;
const PHASES = [
  "prepared",
  "user-data-backed-up",
  "both-roots-backed-up",
  "user-data-published",
  "both-roots-published",
  "committed",
] as const;

const rootEntrySchema = Schema.Struct({
  active: Schema.String,
  staged: Schema.String,
  backup: Schema.String,
});

const activationJournalSchema = Schema.Struct({
  version: Schema.Literal(JOURNAL_VERSION),
  transactionId: Schema.String,
  phase: Schema.Literals(PHASES),
  roots: Schema.Struct({
    userData: rootEntrySchema,
    workspace: rootEntrySchema,
  }),
});

type ActivationJournal = typeof activationJournalSchema.Type;
type ActivationRoot = ActivationJournal["roots"]["userData"];

export interface ServerMigrationActivationOptions {
  /** The current Electron userData directory. It must be on the destination host. */
  userDataRoot: string;
  /** The current ~/OpenBot workspace directory. */
  openBotRoot: string;
  /** A fully materialized, new userData directory beside userDataRoot. */
  stagedUserDataRoot: string;
  /** A fully materialized, new workspace directory beside openBotRoot. */
  stagedOpenBotRoot: string;
}

export interface ServerMigrationActivationTargets {
  userDataRoot: string;
  openBotRoot: string;
}

export interface ActivatedServerMigrationRoots {
  transactionId: string;
  userDataBackupRoot: string;
  openBotBackupRoot: string;
}

export type ServerMigrationActivationRecovery =
  | { status: "none" }
  | { status: "rolled-back" }
  | { status: "committed" };

export class ServerMigrationActivationFailure extends Schema.TaggedError<ServerMigrationActivationFailure>()(
  "ServerMigrationActivationFailure",
  { cause: Schema.Defect() },
) {}

/**
 * Replace the active root pair only after the caller has stopped every writer. This operation
 * never reads or changes the source host. It retains both old destination roots as backups.
 *
 * The journal is durable before the first rename. Any failure before a durable commit attempts a
 * pair rollback. If the commit marker cannot be confirmed, the operation fails and leaves the
 * journal for startup recovery; the caller must not start normal services until recovery succeeds.
 */
export const activateServerMigrationRoots = Effect.fn("ServerMigrationActivation.activate")(function* (
  options: ServerMigrationActivationOptions,
): Effect.fn.Return<ActivatedServerMigrationRoots, ServerMigrationActivationFailure> {
  return yield* Effect.tryPromise({
    try: () => activateRoots(options),
    catch: (cause) => activationFailure(cause),
  });
});

/**
 * Recover one interrupted root-pair activation before opening either active root. An incomplete
 * transaction rolls back both roots. A committed transaction is checked and finalized while its
 * old roots stay in their backup paths. An unknown or mixed state fails closed.
 */
export const recoverServerMigrationActivation = Effect.fn("ServerMigrationActivation.recover")(function* (
  targets: ServerMigrationActivationTargets,
): Effect.fn.Return<ServerMigrationActivationRecovery, ServerMigrationActivationFailure> {
  return yield* Effect.tryPromise({
    try: () => recoverActivation(targets),
    catch: (cause) => activationFailure(cause),
  });
});

export function serverMigrationActivationJournalPath(userDataRoot: string): string {
  const root = resolve(userDataRoot);
  return join(dirname(root), `.${basename(root)}${JOURNAL_SUFFIX}`);
}

async function activateRoots(options: ServerMigrationActivationOptions): Promise<ActivatedServerMigrationRoots> {
  const roots = await resolveActivationRoots(options);
  const journalPath = journalPathForCanonicalRoot(roots.userData.active);
  if (await lstatOptional(journalPath)) {
    throw new Error("A previous server migration activation needs recovery.");
  }

  const transactionId = randomUUID();
  const userDataBackupRoot = backupPath(roots.userData.active, transactionId);
  const openBotBackupRoot = backupPath(roots.workspace.active, transactionId);
  const journal: ActivationJournal = {
    version: JOURNAL_VERSION,
    transactionId,
    phase: "prepared",
    roots: {
      userData: { ...roots.userData, backup: userDataBackupRoot },
      workspace: { ...roots.workspace, backup: openBotBackupRoot },
    },
  };

  assertAllRootsDisjoint([
    journal.roots.userData.active,
    journal.roots.userData.staged,
    journal.roots.userData.backup,
    journal.roots.workspace.active,
    journal.roots.workspace.staged,
    journal.roots.workspace.backup,
  ]);
  await assertMissing(userDataBackupRoot);
  await assertMissing(openBotBackupRoot);

  // Make all imported files and directory entries durable before the commit can name them active.
  await syncTree(journal.roots.userData.staged);
  await syncTree(journal.roots.workspace.staged);
  await assertDirectory(journal.roots.userData.active);
  await assertDirectory(journal.roots.workspace.active);
  await assertDirectory(journal.roots.userData.staged);
  await assertDirectory(journal.roots.workspace.staged);
  await assertMissing(userDataBackupRoot);
  await assertMissing(openBotBackupRoot);
  await assertMissing(journalPath);

  await storeJournal(journalPath, journal, "create");
  let commitMarkerAttempted = false;
  try {
    await rename(journal.roots.userData.active, journal.roots.userData.backup);
    await syncDirectory(dirname(journal.roots.userData.active));
    await writeJournalPhase(journalPath, journal, "user-data-backed-up");

    await rename(journal.roots.workspace.active, journal.roots.workspace.backup);
    await syncDirectory(dirname(journal.roots.workspace.active));
    await writeJournalPhase(journalPath, journal, "both-roots-backed-up");

    await rename(journal.roots.userData.staged, journal.roots.userData.active);
    await syncDirectory(dirname(journal.roots.userData.active));
    await writeJournalPhase(journalPath, journal, "user-data-published");

    await rename(journal.roots.workspace.staged, journal.roots.workspace.active);
    await syncDirectory(dirname(journal.roots.workspace.active));
    await writeJournalPhase(journalPath, journal, "both-roots-published");

    commitMarkerAttempted = true;
    await writeJournalPhase(journalPath, journal, "committed");
  } catch (cause) {
    if (!commitMarkerAttempted) {
      try {
        await recoverActivation({ userDataRoot: roots.userData.active, openBotRoot: roots.workspace.active });
      } catch (recoveryCause) {
        throw new AggregateError([cause, recoveryCause], "Server migration activation and rollback both failed.");
      }
    }
    throw cause;
  }

  // A failed cleanup is safe: startup sees the durable committed marker and retains the backup pair.
  await removeJournal(journalPath).catch(() => undefined);
  return { transactionId, userDataBackupRoot, openBotBackupRoot };
}

async function resolveActivationRoots(options: ServerMigrationActivationOptions): Promise<{
  userData: Omit<ActivationRoot, "backup">;
  workspace: Omit<ActivationRoot, "backup">;
}> {
  const userDataActive = await canonicalRootPath(options.userDataRoot, "userData root");
  const workspaceActive = await canonicalRootPath(options.openBotRoot, "workspace root");
  const userDataStaged = await canonicalRootPath(options.stagedUserDataRoot, "staged userData root");
  const workspaceStaged = await canonicalRootPath(options.stagedOpenBotRoot, "staged workspace root");

  if (dirname(userDataActive) !== dirname(userDataStaged)) {
    throw new Error("The staged userData root must be beside the active userData root.");
  }
  if (dirname(workspaceActive) !== dirname(workspaceStaged)) {
    throw new Error("The staged workspace root must be beside the active workspace root.");
  }
  assertAllRootsDisjoint([userDataActive, userDataStaged, workspaceActive, workspaceStaged]);
  await assertDirectory(userDataActive);
  await assertDirectory(workspaceActive);
  await assertDirectory(userDataStaged);
  await assertDirectory(workspaceStaged);

  return {
    userData: { active: userDataActive, staged: userDataStaged },
    workspace: { active: workspaceActive, staged: workspaceStaged },
  };
}

async function recoverActivation(
  targets: ServerMigrationActivationTargets,
): Promise<ServerMigrationActivationRecovery> {
  const userDataRoot = await canonicalRootPath(targets.userDataRoot, "userData root");
  const openBotRoot = await canonicalRootPath(targets.openBotRoot, "workspace root");
  assertAllRootsDisjoint([userDataRoot, openBotRoot]);
  const journalPath = journalPathForCanonicalRoot(userDataRoot);
  if (!(await lstatOptional(journalPath))) return { status: "none" };

  const journal = await readJournal(journalPath);
  validateJournal(journal, journalPath, userDataRoot, openBotRoot);
  if (journal.phase === "committed") {
    await assertCommittedPair(journal);
    await removeJournal(journalPath).catch(() => undefined);
    return { status: "committed" };
  }

  await rollbackPair(journal);
  await removeJournal(journalPath);
  return { status: "rolled-back" };
}

async function rollbackPair(journal: ActivationJournal): Promise<void> {
  // Preflight both halves before changing either. A state we cannot prove safe blocks startup.
  const userDataPlan = await planRollback(journal.roots.userData);
  const workspacePlan = await planRollback(journal.roots.workspace);
  await applyRollback(journal.roots.userData, userDataPlan);
  await applyRollback(journal.roots.workspace, workspacePlan);
  await assertRestoredRoot(journal.roots.userData);
  await assertRestoredRoot(journal.roots.workspace);
}

type RollbackPlan = "already-restored" | "restore-backup" | "return-new-then-restore";

async function planRollback(root: ActivationRoot): Promise<RollbackPlan> {
  const [active, staged, backup] = await Promise.all([
    inspectDirectory(root.active),
    inspectDirectory(root.staged),
    inspectDirectory(root.backup),
  ]);
  if (active && staged && !backup) return "already-restored";
  if (!active && staged && backup) return "restore-backup";
  if (active && !staged && backup) return "return-new-then-restore";
  throw new Error("The migration journal does not match a safe root state.");
}

async function applyRollback(root: ActivationRoot, plan: RollbackPlan): Promise<void> {
  if (plan === "already-restored") return;
  if (plan === "return-new-then-restore") {
    await rename(root.active, root.staged);
    await syncDirectory(dirname(root.active));
  }
  await rename(root.backup, root.active);
  await syncDirectory(dirname(root.active));
}

async function assertRestoredRoot(root: ActivationRoot): Promise<void> {
  await assertDirectory(root.active);
  await assertDirectory(root.staged);
  await assertMissing(root.backup);
}

async function assertCommittedPair(journal: ActivationJournal): Promise<void> {
  await assertDirectory(journal.roots.userData.active);
  await assertDirectory(journal.roots.workspace.active);
  await assertDirectory(journal.roots.userData.backup);
  await assertDirectory(journal.roots.workspace.backup);
  await assertMissing(journal.roots.userData.staged);
  await assertMissing(journal.roots.workspace.staged);
}

async function readJournal(path: string): Promise<ActivationJournal> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES) {
    throw new Error("The migration activation journal is not a valid regular file.");
  }
  const handle = await open(path, "r");
  let text: string;
  try {
    text = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  return Schema.decodeUnknownSync(activationJournalSchema, { onExcessProperty: "error" })(JSON.parse(text));
}

function validateJournal(
  journal: ActivationJournal,
  journalPath: string,
  expectedUserDataRoot: string,
  expectedOpenBotRoot: string,
): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(journal.transactionId)) {
    throw new Error("The migration activation journal has an invalid transaction ID.");
  }
  const { userData, workspace } = journal.roots;
  if (userData.active !== expectedUserDataRoot || workspace.active !== expectedOpenBotRoot) {
    throw new Error("The migration activation journal names different active roots.");
  }
  for (const root of [userData, workspace]) {
    if (![root.active, root.staged, root.backup].every(isCanonicalAbsolutePath)) {
      throw new Error("The migration activation journal contains a non-canonical path.");
    }
    if (dirname(root.active) !== dirname(root.staged) || dirname(root.active) !== dirname(root.backup)) {
      throw new Error("The migration activation journal contains a root outside its destination volume.");
    }
  }
  if (
    userData.backup !== backupPath(userData.active, journal.transactionId) ||
    workspace.backup !== backupPath(workspace.active, journal.transactionId)
  ) {
    throw new Error("The migration activation journal contains an unexpected backup path.");
  }
  if (journalPath !== journalPathForCanonicalRoot(userData.active)) {
    throw new Error("The migration activation journal is stored beside a different userData root.");
  }
  assertAllRootsDisjoint([
    userData.active,
    userData.staged,
    userData.backup,
    workspace.active,
    workspace.staged,
    workspace.backup,
  ]);
}

async function writeJournalPhase(
  path: string,
  journal: ActivationJournal,
  phase: ActivationJournal["phase"],
): Promise<void> {
  await storeJournal(path, { ...journal, phase }, "replace");
}

async function storeJournal(path: string, journal: ActivationJournal, mode: "create" | "replace"): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (mode === "create") await link(temporary, path);
    else await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function removeJournal(path: string): Promise<void> {
  await unlink(path).catch((cause: unknown) => {
    if (errorCode(cause) !== "ENOENT") throw cause;
  });
  await syncDirectory(dirname(path));
}

async function canonicalRootPath(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`The ${label} must be an absolute path.`);
  const resolved = resolve(path);
  const name = basename(resolved);
  if (!name || name === "." || name === ".." || name === sep) {
    throw new Error(`The ${label} is not a valid directory path.`);
  }
  const parent = dirname(resolved);
  await assertDirectory(parent);
  return join(await realpath(parent), name);
}

function journalPathForCanonicalRoot(userDataRoot: string): string {
  return join(dirname(userDataRoot), `.${basename(userDataRoot)}${JOURNAL_SUFFIX}`);
}

function backupPath(activeRoot: string, transactionId: string): string {
  return join(dirname(activeRoot), `.${basename(activeRoot)}.openbot-migration-backup-${transactionId}`);
}

function isCanonicalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path;
}

function assertAllRootsDisjoint(paths: readonly string[]): void {
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    const left = paths[leftIndex];
    if (!left) throw new Error("The migration root list is incomplete.");
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const right = paths[rightIndex];
      if (!right || isWithin(left, right) || isWithin(right, left)) {
        throw new Error("The migration roots overlap.");
      }
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function syncTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    const info = await lstat(child);
    if (info.isSymbolicLink()) throw new Error("A staged migration root contains a symbolic link.");
    if (info.isDirectory()) {
      await syncTree(child);
    } else if (info.isFile()) {
      const handle = await open(child, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      throw new Error("A staged migration root contains an unsupported file type.");
    }
  }
  await syncDirectory(root);
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("A migration root is not a real directory.");
}

async function inspectDirectory(path: string): Promise<boolean> {
  const info = await lstatOptional(path);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("A migration root is not a real directory.");
  return true;
}

async function assertMissing(path: string): Promise<void> {
  if (await lstatOptional(path)) throw new Error("A migration destination path is already in use.");
}

async function lstatOptional(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return null;
    throw cause;
  }
}

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function activationFailure(cause: unknown): ServerMigrationActivationFailure {
  return cause instanceof ServerMigrationActivationFailure ? cause : new ServerMigrationActivationFailure({ cause });
}
