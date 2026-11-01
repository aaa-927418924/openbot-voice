// The destination side of `server-migration-v1`: receive a verified snapshot, build new active
// roots beside the current ones, keep this host's own identity, then ask the process to restart.
//
// The source host is never touched. The previous destination roots stay as backups, so this
// operation does not delete data. The activation journal makes an interrupted replacement fail
// closed at the next start instead of running on a half-published root pair.

import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import {
  activateServerMigrationRoots,
  recoverServerMigrationActivation,
  type ServerMigrationActivationRecovery,
} from "./server-migration-activation";
import { importServerMigrationSnapshot } from "./server-migration-snapshot";
import { ServerMigrationTransferService } from "./server-migration-transfer";
import type { TeamApiServerMigration } from "./team-api/dependencies";

const RECORD_VERSION = 1;
const RECORD_SUFFIX = ".server-migration-activation";
const MAX_RECORD_BYTES = 16 * 1024;

const recordSchema = z
  .object({
    version: z.literal(RECORD_VERSION),
    transferId: z.string(),
    phase: z.enum(["prepared", "publishing", "activated"]),
    stagedUserDataRoot: z.string(),
    stagedOpenBotRoot: z.string(),
    updatedAt: z.string(),
  })
  .strict();

type ActivationRecord = z.infer<typeof recordSchema>;

/**
 * This host's own files. A snapshot never contains them, and they must describe this computer and
 * its signed-in account after activation, not the source computer.
 */
const CONTINUITY_FILES = [
  "openbot-team-server-v2.json",
  "openbot-team-server-v1.json",
  "openbot-central-auth-v1.bin",
  "local-server-preference-v1.json",
  "openbot-remote-servers-v1.json",
  "openbot-setup-v2.json",
  "local-profile.json",
] as const;
const CONTINUITY_DIRECTORIES = ["openbot-team-server-v2.json.assets", "openbot-team-server-v1.json.assets"] as const;
const CONTINUITY_PREFIX = "self-hosted-";

export interface ServerMigrationDestinationOptions {
  /** The active Electron userData directory of this host. */
  userDataRoot: string;
  /** The active `~/OpenBot` workspace directory of this host. */
  openBotRoot: string;
  /** A private directory for received snapshots. It must not be inside either active root. */
  stagingRoot: string;
  /** Answers true only for the authenticated owner of this host. */
  assertOwner: (memberId: string) => Promise<void>;
  /** Asks the process to restart after the new roots are published and the response can flush. */
  onActivated: () => void;
}

export class ServerMigrationDestination {
  readonly #userDataRoot: string;
  readonly #openBotRoot: string;
  readonly #onActivated: () => void;
  readonly transfer: ServerMigrationTransferService;
  readonly migration: TeamApiServerMigration;

  constructor(options: ServerMigrationDestinationOptions) {
    this.#userDataRoot = resolve(options.userDataRoot);
    this.#openBotRoot = resolve(options.openBotRoot);
    this.#onActivated = options.onActivated;
    this.transfer = new ServerMigrationTransferService({
      stagingRoot: options.stagingRoot,
      assertOwner: options.assertOwner,
    });
    this.migration = {
      serverMode: true,
      transfer: this.transfer,
      activate: (input) => this.#activate(input.transferId, input.snapshotPath),
    };
  }

  async #activate(transferId: string, snapshotPath: string): Promise<void> {
    const recordPath = activationRecordPath(this.#userDataRoot, transferId);
    const existing = await readRecord(recordPath);
    if (existing?.phase === "activated") return;

    const recovery = await Effect.runPromise(
      recoverServerMigrationActivation({ userDataRoot: this.#userDataRoot, openBotRoot: this.#openBotRoot }),
    );
    if (recovery.status === "committed" && existing) {
      await writeRecord(recordPath, { ...existing, phase: "activated", updatedAt: new Date().toISOString() });
      return;
    }

    if (existing) {
      // A previous attempt did not publish. Its staged roots are this host's own incomplete copies.
      await removeStagedRoot(existing.stagedUserDataRoot, this.#userDataRoot);
      await removeStagedRoot(existing.stagedOpenBotRoot, this.#openBotRoot);
    }

    const suffix = randomUUID().slice(0, 8);
    const record: ActivationRecord = {
      version: RECORD_VERSION,
      transferId,
      phase: "prepared",
      stagedUserDataRoot: `${this.#userDataRoot}.migration-${suffix}`,
      stagedOpenBotRoot: `${this.#openBotRoot}.migration-${suffix}`,
      updatedAt: new Date().toISOString(),
    };
    await writeRecord(recordPath, record);
    await importServerMigrationSnapshot({
      snapshotPath,
      userDataRoot: record.stagedUserDataRoot,
      openBotRoot: record.stagedOpenBotRoot,
      attachmentOpenBotRoot: this.#openBotRoot,
    });
    await preserveDestinationContinuity(this.#userDataRoot, record.stagedUserDataRoot);

    await writeRecord(recordPath, { ...record, phase: "publishing", updatedAt: new Date().toISOString() });
    await Effect.runPromise(
      activateServerMigrationRoots({
        userDataRoot: this.#userDataRoot,
        openBotRoot: this.#openBotRoot,
        stagedUserDataRoot: record.stagedUserDataRoot,
        stagedOpenBotRoot: record.stagedOpenBotRoot,
      }),
    );
    await writeRecord(recordPath, { ...record, phase: "activated", updatedAt: new Date().toISOString() });
    this.#onActivated();
  }
}

/** Marks a replacement that finished before its process exited, and leaves the rest for a retry. */
export async function reconcileServerMigrationActivations(userDataRoot: string): Promise<void> {
  const directory = activationRecordDirectory(userDataRoot);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const record = await readRecord(path);
    if (!record || record.phase === "activated") continue;
    const staged = (await pathExists(record.stagedUserDataRoot)) || (await pathExists(record.stagedOpenBotRoot));
    // Only a publishing record proves that root activation began. A prepared record can have no
    // staged roots when import validation failed before it created either directory; marking that
    // attempt activated would make every retry a no-op and hide the failed migration.
    if (record.phase === "publishing" && !staged) {
      await writeRecord(path, { ...record, phase: "activated", updatedAt: new Date().toISOString() });
    }
  }
}

export async function recoverServerMigrationAtStartup(input: {
  userDataRoot: string;
  openBotRoot: string;
}): Promise<ServerMigrationActivationRecovery> {
  const recovery = await Effect.runPromise(recoverServerMigrationActivation(input));
  await reconcileServerMigrationActivations(input.userDataRoot);
  return recovery;
}

export function activationRecordDirectory(userDataRoot: string): string {
  const root = resolve(userDataRoot);
  return join(dirname(root), `.${basename(root)}${RECORD_SUFFIX}`);
}

function activationRecordPath(userDataRoot: string, transferId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(transferId)) throw new Error("Invalid migration transfer ID.");
  return join(activationRecordDirectory(userDataRoot), `${transferId}.json`);
}

async function removeStagedRoot(staged: string, active: string): Promise<void> {
  // Refuse a record that points at an active root: only this host's own sibling copies are deleted.
  if (dirname(resolve(staged)) !== dirname(resolve(active)) || resolve(staged) === resolve(active)) {
    throw new Error("The migration activation record names an unsafe staged root.");
  }
  await rm(staged, { recursive: true, force: true });
}

async function preserveDestinationContinuity(active: string, staged: string): Promise<void> {
  for (const name of CONTINUITY_FILES) {
    await copyIfPresent(join(active, name), join(staged, name));
  }
  for (const name of CONTINUITY_DIRECTORIES) {
    await copyIfPresent(join(active, name), join(staged, name));
  }
  const entries = await readdir(active, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(CONTINUITY_PREFIX)) continue;
    if (!entry.isFile() && !entry.isDirectory()) continue;
    await copyIfPresent(join(active, entry.name), join(staged, entry.name));
  }
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  const info = await lstat(source).catch(() => null);
  if (!info) return;
  await cp(source, target, { recursive: info.isDirectory(), force: true, dereference: false });
}

async function readRecord(path: string): Promise<ActivationRecord | null> {
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) {
    throw new Error("The migration activation record is not a valid regular file.");
  }
  const handle = await open(path, "r");
  let value: unknown;
  try {
    value = JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
  const decoded = recordSchema.safeParse(value);
  if (!decoded.success) throw new Error("The migration activation record is malformed.");
  return decoded.data;
}

async function writeRecord(path: string, record: ActivationRecord): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function pathExists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}
