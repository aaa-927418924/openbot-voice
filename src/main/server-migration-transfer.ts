import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import { z } from "zod";
import {
  SERVER_MIGRATION_SNAPSHOT_VERSION,
  ServerMigrationSnapshotError,
  type ServerMigrationSnapshotManifest,
  verifyServerMigrationSnapshot,
} from "./server-migration-snapshot";

const RECORD_VERSION = 1;
const RECORD_NAME = "transfer.json";
const SNAPSHOT_NAME = "snapshot";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PORTABLE_ATTACHMENT_PREFIX = "openbot-migration-path://";
const REQUIRED_FILES = ["user-data/openbot.db", "home/OpenBot/Shared/Data/agent-data.db"];
const FIXED_FILES = new Set([
  ...REQUIRED_FILES,
  "user-data/mailbox.json",
  "user-data/bots.json",
  "user-data/openbot-sidebar-layout-v1.json",
]);
const ASSET_ROOTS = [
  "user-data/openbot-team-server-v1.json.assets/logo",
  "user-data/openbot-team-server-v2.json.assets/logo",
] as const;
const WORKSPACE_ROOTS = ["home/OpenBot/Agents", "home/OpenBot/Bots", "home/OpenBot/Shared"] as const;
const ROOT_DIRECTORIES = new Set(["user-data", "home", "home/OpenBot"]);
const ASSET_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

const manifestSchema = z
  .object({
    version: z.literal(SERVER_MIGRATION_SNAPSHOT_VERSION),
    createdAt: z.string(),
    directories: z.array(z.string()),
    files: z.array(
      z
        .object({
          path: z.string(),
          bytes: z.number().int().nonnegative(),
          sha256: z.string().regex(SHA256),
        })
        .strict(),
    ),
    missingAttachmentPaths: z.array(z.string().max(4096)).optional(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
const chunkSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(SHA256),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(RECORD_VERSION),
    id: z.string().regex(UUID),
    requestId: z.string().regex(UUID),
    ownerMemberId: z.string().regex(OWNER_ID),
    state: z.enum(["receiving", "paused", "verified"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    manifest: manifestSchema,
    progress: z.record(
      z.string(),
      z
        .object({
          receivedBytes: z.number().int().nonnegative(),
          chunks: z.array(chunkSchema),
        })
        .strict(),
    ),
  })
  .strict();

export interface ServerMigrationTransferLimits {
  chunkBytes: number;
  transferBytes: number;
  retainedBytes: number;
  transferCount: number;
  manifestBytes: number;
  fileCount: number;
  chunkCount: number;
  fileBytes: number;
}

export interface ServerMigrationTransferOptions {
  /** A private directory chosen by the host main process. Never accept this from a request. */
  stagingRoot: string;
  /** Rejects unless memberId is the authenticated owner of this host. */
  assertOwner: (memberId: string) => void | Promise<void>;
  limits?: Partial<ServerMigrationTransferLimits>;
}

export interface ServerMigrationTransferInput {
  memberId: string;
  /** Client-generated UUID used for idempotent begin retries, never as a path. */
  requestId: string;
  manifest: unknown;
}

export interface ServerMigrationChunkInput {
  memberId: string;
  transferId: string;
  path: string;
  offset: number;
  bytes: Uint8Array;
  sha256: string;
}

export interface ServerMigrationTransferStatus {
  transferId: string;
  state: "receiving" | "paused" | "verified";
  totalBytes: number;
  receivedBytes: number;
  files: Array<{ path: string; bytes: number; receivedBytes: number; complete: boolean }>;
}

export interface VerifiedServerMigrationTransfer {
  transferId: string;
  manifest: ServerMigrationSnapshotManifest;
}

const DEFAULT_LIMITS: ServerMigrationTransferLimits = {
  chunkBytes: 4 * 1024 * 1024,
  transferBytes: 64 * 1024 * 1024 * 1024,
  retainedBytes: 128 * 1024 * 1024 * 1024,
  transferCount: 3,
  manifestBytes: 8 * 1024 * 1024,
  fileCount: 50_000,
  chunkCount: 40_000,
  fileBytes: 64 * 1024 * 1024 * 1024,
};

export class ServerMigrationTransferFailure extends Schema.TaggedError<ServerMigrationTransferFailure>()(
  "ServerMigrationTransferFailure",
  {
    code: Schema.Literals([
      "owner_required",
      "invalid_manifest",
      "invalid_transfer",
      "transfer_conflict",
      "invalid_chunk",
      "transfer_incomplete",
      "capacity_exceeded",
      "verification_failed",
      "storage_error",
    ]),
    message: Schema.String,
  },
) {}
export type ServerMigrationTransferFailureCode = ServerMigrationTransferFailure["code"];

/**
 * Receives an allowlisted snapshot into host-owned staging. This service never reads source paths,
 * promotes active roots, restarts the host, or deletes source data. Cancellation pauses and retains
 * staged bytes. The caller must finalize, import through withVerifiedSnapshot, and only then call
 * discardVerified. Never serialize the callback's private path. Recheck ownership at each route.
 */
export class ServerMigrationTransferService {
  readonly #root: string;
  readonly #assertOwner: ServerMigrationTransferOptions["assertOwner"];
  readonly #limits: ServerMigrationTransferLimits;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: ServerMigrationTransferOptions) {
    if (!isAbsolute(options.stagingRoot)) throw new TypeError("The staging root must be absolute.");
    this.#root = resolve(options.stagingRoot);
    this.#assertOwner = options.assertOwner;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    validateLimits(this.#limits);
  }

  readonly begin = Effect.fn("ServerMigrationTransfer.begin")(function* (
    this: ServerMigrationTransferService,
    input: ServerMigrationTransferInput,
  ): Effect.fn.Return<ServerMigrationTransferStatus, ServerMigrationTransferFailure> {
    return yield* Effect.tryPromise({
      try: () => this.#begin(input),
      catch: toFailure,
    });
  }).bind(this);

  readonly status = Effect.fn("ServerMigrationTransfer.status")(function* (
    this: ServerMigrationTransferService,
    memberId: string,
    transferId: string,
  ): Effect.fn.Return<ServerMigrationTransferStatus, ServerMigrationTransferFailure> {
    return yield* Effect.tryPromise({
      try: () => this.#status(memberId, transferId),
      catch: toFailure,
    });
  }).bind(this);

  readonly writeChunk = Effect.fn("ServerMigrationTransfer.writeChunk")(function* (
    this: ServerMigrationTransferService,
    input: ServerMigrationChunkInput,
  ): Effect.fn.Return<ServerMigrationTransferStatus, ServerMigrationTransferFailure> {
    return yield* Effect.tryPromise({
      try: () => this.#writeChunk(input),
      catch: toFailure,
    });
  }).bind(this);

  /** Cancellation is a retained pause, not deletion. */
  readonly cancel = Effect.fn("ServerMigrationTransfer.cancel")(function* (
    this: ServerMigrationTransferService,
    memberId: string,
    transferId: string,
  ): Effect.fn.Return<ServerMigrationTransferStatus, ServerMigrationTransferFailure> {
    return yield* Effect.tryPromise({
      try: () => this.#changeState(memberId, transferId, "paused"),
      catch: toFailure,
    });
  }).bind(this);

  readonly resume = Effect.fn("ServerMigrationTransfer.resume")(function* (
    this: ServerMigrationTransferService,
    memberId: string,
    transferId: string,
  ): Effect.fn.Return<ServerMigrationTransferStatus, ServerMigrationTransferFailure> {
    return yield* Effect.tryPromise({
      try: () => this.#changeState(memberId, transferId, "receiving"),
      catch: toFailure,
    });
  }).bind(this);

  /** Returns only the verified manifest and opaque transfer ID. */
  readonly finalize = Effect.fn("ServerMigrationTransfer.finalize")(function* (
    this: ServerMigrationTransferService,
    memberId: string,
    transferId: string,
  ): Effect.fn.Return<VerifiedServerMigrationTransfer, ServerMigrationTransferFailure> {
    return yield* Effect.tryPromise({
      try: () => this.#finalize(memberId, transferId),
      catch: toFailure,
    });
  }).bind(this);

  /**
   * Pass the verified snapshot path only to trusted main-process import code. The path is never a
   * return value, IPC value, or wire field. A failed callback leaves the transfer available for an
   * idempotent import or promotion retry.
   */
  readonly withVerifiedSnapshot = Effect.fn("ServerMigrationTransfer.withVerifiedSnapshot")(function* (
    this: ServerMigrationTransferService,
    memberId: string,
    transferId: string,
    consume: (snapshotPath: string, manifest: ServerMigrationSnapshotManifest) => Promise<void>,
  ): Effect.fn.Return<ServerMigrationSnapshotManifest, ServerMigrationTransferFailure> {
    return yield* Effect.tryPromise({
      try: () => this.#withVerifiedSnapshot(memberId, transferId, consume),
      catch: toFailure,
    });
  }).bind(this);

  /** Call only after successful import. Never call this for a cancelled transfer. */
  readonly discardVerified = Effect.fn("ServerMigrationTransfer.discardVerified")(function* (
    this: ServerMigrationTransferService,
    memberId: string,
    transferId: string,
  ): Effect.fn.Return<void, ServerMigrationTransferFailure> {
    return yield* Effect.tryPromise({
      try: () => this.#discardVerified(memberId, transferId),
      catch: toFailure,
    });
  }).bind(this);

  async #begin(input: ServerMigrationTransferInput): Promise<ServerMigrationTransferStatus> {
    await this.#authorize(input.memberId);
    if (!UUID.test(input.requestId)) fail("invalid_transfer", "The request id is invalid.");
    const manifest = parseManifest(input.manifest, this.#limits);
    return this.#exclusive("begin", async () => {
      await this.#ensureRoot();
      await this.#cleanAbandonedBegins();
      const existing = await this.#findByRequestId(input.memberId, input.requestId);
      if (existing) {
        if (canonicalManifest(existing.manifest) !== canonicalManifest(manifest)) {
          fail("transfer_conflict", "The request id is already used for another snapshot.");
        }
        return toStatus(existing);
      }
      const saved = await this.#listRecords();
      const retainedBytes = saved.reduce((total, item) => total + item.manifest.totalBytes, 0);
      if (
        saved.length >= this.#limits.transferCount ||
        retainedBytes + manifest.totalBytes > this.#limits.retainedBytes
      ) {
        fail("capacity_exceeded", "The migration staging area has reached its limit.");
      }

      const id = randomUUID();
      const transferDirectory = this.#transferDirectory(id);
      const beginDirectory = this.#beginDirectory(id);
      const snapshotDirectory = join(beginDirectory, SNAPSHOT_NAME);
      await mkdir(beginDirectory, { mode: 0o700 });
      try {
        await mkdir(snapshotDirectory, { mode: 0o700 });
        for (const path of [...manifest.directories].sort(compareDepth)) {
          await this.#makeDirectory(snapshotDirectory, path);
        }
        const progress: Record<string, FileProgress> = {};
        for (const file of manifest.files) {
          const path = this.#snapshotPath(snapshotDirectory, file.path);
          await this.#assertSafePath(snapshotDirectory, file.path, true);
          const handle = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
            0o600,
          );
          await handle.sync();
          await handle.close();
          progress[file.path] = { receivedBytes: 0, chunks: [] };
        }
        await writeNewFile(join(snapshotDirectory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
        const now = new Date().toISOString();
        const record: TransferRecord = {
          version: RECORD_VERSION,
          id,
          requestId: input.requestId,
          ownerMemberId: input.memberId,
          state: "receiving",
          createdAt: now,
          updatedAt: now,
          manifest,
          progress,
        };
        await this.#writeRecord(beginDirectory, record);
        await rename(beginDirectory, transferDirectory);
        return toStatus(record);
      } catch (cause) {
        await rm(beginDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw cause;
      }
    });
  }

  async #status(memberId: string, transferId: string): Promise<ServerMigrationTransferStatus> {
    await this.#authorize(memberId);
    assertId(transferId);
    return this.#exclusive(transferId, async () => toStatus(await this.#load(memberId, transferId)));
  }

  async #writeChunk(input: ServerMigrationChunkInput): Promise<ServerMigrationTransferStatus> {
    await this.#authorize(input.memberId);
    assertId(input.transferId);
    return this.#exclusive(input.transferId, async () => {
      const record = await this.#load(input.memberId, input.transferId);
      if (record.state !== "receiving") fail("transfer_conflict", "The transfer is not accepting chunks.");
      const expected = record.manifest.files.find((file) => file.path === input.path);
      if (!expected || !allowedFile(input.path)) fail("invalid_chunk", "The file is not in the allowlisted manifest.");
      if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !SHA256.test(input.sha256)) {
        fail("invalid_chunk", "The chunk metadata is invalid.");
      }
      if (input.bytes.byteLength < 1 || input.bytes.byteLength > this.#limits.chunkBytes) {
        fail("invalid_chunk", "The chunk size exceeds the supported limit.");
      }
      const bytes = Buffer.from(input.bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== input.sha256) fail("invalid_chunk", "The chunk checksum does not match.");
      const progress = record.progress[input.path];
      if (!progress) fail("storage_error", "The file progress record is missing.");
      const snapshotDirectory = this.#snapshotDirectory(record.id);
      const target = this.#snapshotPath(snapshotDirectory, input.path);
      await this.#assertSafePath(snapshotDirectory, input.path);

      const repeated = progress.chunks.find((chunk) => chunk.offset === input.offset);
      if (repeated) {
        if (repeated.bytes !== bytes.byteLength || repeated.sha256 !== digest) {
          fail("invalid_chunk", "A repeated chunk does not match the saved chunk.");
        }
        await this.#verifyChunk(target, repeated);
        return toStatus(record);
      }
      if (input.offset !== progress.receivedBytes) fail("invalid_chunk", "Chunks must arrive in order without gaps.");
      const expectedBytes = Math.min(this.#limits.chunkBytes, expected.bytes - input.offset);
      if (
        expectedBytes <= 0 ||
        bytes.byteLength !== expectedBytes ||
        input.offset % this.#limits.chunkBytes !== 0 ||
        input.offset + bytes.byteLength > expected.bytes
      ) {
        fail("invalid_chunk", "The chunk does not match the next expected file range.");
      }
      const totalChunks = Object.values(record.progress).reduce((total, item) => total + item.chunks.length, 0);
      if (totalChunks >= this.#limits.chunkCount) fail("capacity_exceeded", "The transfer has too many chunks.");

      const handle = await open(target, constants.O_RDWR | noFollow());
      try {
        const info = await handle.stat();
        if (!info.isFile()) fail("invalid_chunk", "The staged file is not a regular file.");
        if (info.size < progress.receivedBytes) fail("storage_error", "The staged file is shorter than its journal.");
        // A crash may save the file before the journal. Remove only this uncommitted tail.
        if (info.size > progress.receivedBytes) await handle.truncate(progress.receivedBytes);
        await writeAt(handle, bytes, input.offset);
        await handle.sync();
      } finally {
        await handle.close();
      }
      progress.chunks.push({ offset: input.offset, bytes: bytes.byteLength, sha256: digest });
      progress.receivedBytes += bytes.byteLength;
      record.updatedAt = new Date().toISOString();
      await this.#writeRecord(this.#transferDirectory(record.id), record);
      return toStatus(record);
    });
  }

  async #changeState(
    memberId: string,
    transferId: string,
    state: "receiving" | "paused",
  ): Promise<ServerMigrationTransferStatus> {
    await this.#authorize(memberId);
    assertId(transferId);
    return this.#exclusive(transferId, async () => {
      const record = await this.#load(memberId, transferId);
      if (record.state === "verified") fail("transfer_conflict", "A verified transfer cannot be resumed or cancelled.");
      record.state = state;
      record.updatedAt = new Date().toISOString();
      await this.#writeRecord(this.#transferDirectory(record.id), record);
      return toStatus(record);
    });
  }

  async #finalize(memberId: string, transferId: string): Promise<VerifiedServerMigrationTransfer> {
    await this.#authorize(memberId);
    assertId(transferId);
    return this.#exclusive(transferId, async () => {
      const record = await this.#load(memberId, transferId);
      if (record.state === "paused") fail("transfer_conflict", "Resume the transfer before finalizing it.");
      for (const file of record.manifest.files) {
        if (record.progress[file.path]?.receivedBytes !== file.bytes) {
          fail("transfer_incomplete", "The snapshot contains files that were not fully received.");
        }
      }
      let manifest: ServerMigrationSnapshotManifest;
      try {
        manifest = await verifyServerMigrationSnapshot(this.#snapshotDirectory(record.id));
      } catch {
        fail("verification_failed", "The snapshot failed integrity verification.");
      }
      if (canonicalManifest(manifest) !== canonicalManifest(record.manifest)) {
        fail("verification_failed", "The snapshot manifest changed during verification.");
      }
      record.state = "verified";
      record.updatedAt = new Date().toISOString();
      await this.#writeRecord(this.#transferDirectory(record.id), record);
      return {
        transferId: record.id,
        manifest,
      };
    });
  }

  async #withVerifiedSnapshot(
    memberId: string,
    transferId: string,
    consume: (snapshotPath: string, manifest: ServerMigrationSnapshotManifest) => Promise<void>,
  ): Promise<ServerMigrationSnapshotManifest> {
    await this.#authorize(memberId);
    assertId(transferId);
    return this.#exclusive(transferId, async () => {
      const record = await this.#load(memberId, transferId);
      if (record.state !== "verified") fail("transfer_conflict", "The snapshot has not been verified.");
      let manifest: ServerMigrationSnapshotManifest;
      try {
        manifest = await verifyServerMigrationSnapshot(this.#snapshotDirectory(record.id));
      } catch {
        fail("verification_failed", "The snapshot failed integrity verification.");
      }
      if (canonicalManifest(manifest) !== canonicalManifest(record.manifest)) {
        fail("verification_failed", "The snapshot manifest changed during verification.");
      }
      await consume(this.#snapshotDirectory(record.id), manifest);
      return manifest;
    });
  }

  async #discardVerified(memberId: string, transferId: string): Promise<void> {
    await this.#authorize(memberId);
    assertId(transferId);
    await this.#exclusive(transferId, async () => {
      const record = await this.#load(memberId, transferId);
      if (record.state !== "verified") fail("transfer_conflict", "Only a verified transfer can be discarded.");
      const directory = this.#transferDirectory(record.id);
      await assertRealDirectory(directory);
      await rm(directory, { recursive: true });
    });
  }

  async #authorize(memberId: string): Promise<void> {
    if (!OWNER_ID.test(memberId)) fail("owner_required", "The authenticated owner is required.");
    try {
      await this.#assertOwner(memberId);
    } catch {
      fail("owner_required", "The authenticated owner is required.");
    }
  }

  async #ensureRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      fail("storage_error", "The migration staging root must be a private directory.");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      fail("storage_error", "The migration staging root must belong to the server user.");
    }
    if ((await realpath(this.#root)) !== this.#root) {
      fail("storage_error", "The migration staging root cannot resolve through a symbolic link.");
    }
  }

  async #cleanAbandonedBegins(): Promise<void> {
    const entries = await readdir(this.#root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(".begin-") || !UUID.test(entry.name.slice(".begin-".length))) continue;
      const path = join(this.#root, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        fail("storage_error", "An abandoned begin entry is unsafe.");
      }
      await assertRealDirectory(path);
      await rm(path, { recursive: true });
    }
  }

  async #findByRequestId(memberId: string, requestId: string): Promise<TransferRecord | null> {
    for (const record of await this.#listRecords()) {
      if (record.requestId !== requestId) continue;
      if (record.ownerMemberId !== memberId) fail("owner_required", "The request belongs to another owner.");
      return record;
    }
    return null;
  }

  async #listRecords(): Promise<TransferRecord[]> {
    const entries = await readdir(this.#root, { withFileTypes: true });
    const records: TransferRecord[] = [];
    for (const entry of entries) {
      if (!UUID.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail("storage_error", "An unsafe transfer entry exists.");
      records.push(await this.#readRecord(join(this.#root, entry.name)));
    }
    return records;
  }

  async #load(memberId: string, transferId: string): Promise<TransferRecord> {
    const record = await this.#readRecord(this.#transferDirectory(transferId));
    if (record.id !== transferId || record.ownerMemberId !== memberId) {
      fail("owner_required", "The transfer is not available to this owner.");
    }
    return record;
  }

  async #readRecord(directory: string): Promise<TransferRecord> {
    await assertRealDirectory(directory);
    const path = join(directory, RECORD_NAME);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > this.#limits.manifestBytes * 2) {
      fail("storage_error", "A transfer record is unsafe or too large.");
    }
    const handle = await open(path, constants.O_RDONLY | noFollow());
    let data: unknown;
    try {
      data = JSON.parse(await handle.readFile("utf8"));
    } catch {
      fail("storage_error", "A transfer record is invalid.");
    } finally {
      await handle.close();
    }
    const decoded = recordSchema.safeParse(data);
    if (!decoded.success || decoded.data.id !== basename(directory))
      fail("storage_error", "A transfer record is malformed.");
    const record: TransferRecord = decoded.data;
    const manifest = parseManifest(record.manifest, this.#limits);
    if (canonicalManifest(manifest) !== canonicalManifest(record.manifest)) {
      fail("storage_error", "A saved transfer manifest changed.");
    }
    validateProgress(record, this.#limits);
    return record;
  }

  async #writeRecord(directory: string, record: TransferRecord): Promise<void> {
    const temporary = join(directory, `.transfer-${randomUUID()}.tmp`);
    await writeNewFile(temporary, `${JSON.stringify(record)}\n`);
    await rename(temporary, join(directory, RECORD_NAME));
  }

  async #makeDirectory(snapshotDirectory: string, path: string): Promise<void> {
    const target = this.#snapshotPath(snapshotDirectory, path);
    await this.#assertSafePath(snapshotDirectory, path, true);
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (cause) {
      if (!isExists(cause)) throw cause;
    }
    await assertRealDirectory(target);
  }

  async #assertSafePath(snapshotDirectory: string, path: string, allowMissingLeaf = false): Promise<void> {
    const target = this.#snapshotPath(snapshotDirectory, path);
    let current = snapshotDirectory;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index] ?? "");
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) fail("invalid_chunk", "Snapshot paths cannot contain symbolic links.");
        if (index < parts.length - 1 && !info.isDirectory()) fail("invalid_chunk", "A path crosses a non-directory.");
      } catch (cause) {
        if (allowMissingLeaf && index === parts.length - 1 && isMissing(cause)) continue;
        if (isMissing(cause)) fail("storage_error", "A snapshot path is missing.");
        throw cause;
      }
    }
    if (!isWithin(snapshotDirectory, target)) fail("invalid_manifest", "A snapshot path escaped its root.");
  }

  #snapshotPath(snapshotDirectory: string, path: string): string {
    if (!safeRelativePath(path)) fail("invalid_manifest", "A snapshot path is not a safe relative path.");
    const target = resolve(snapshotDirectory, ...path.split("/"));
    if (!isWithin(snapshotDirectory, target)) fail("invalid_manifest", "A snapshot path escaped its root.");
    return target;
  }

  #transferDirectory(id: string): string {
    assertId(id);
    return join(this.#root, id);
  }

  #beginDirectory(id: string): string {
    assertId(id);
    return join(this.#root, `.begin-${id}`);
  }

  #snapshotDirectory(id: string): string {
    return join(this.#transferDirectory(id), SNAPSHOT_NAME);
  }

  async #verifyChunk(path: string, chunk: ChunkRecord): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | noFollow());
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < chunk.offset + chunk.bytes) fail("storage_error", "A saved chunk is missing.");
      const buffer = Buffer.alloc(chunk.bytes);
      const result = await handle.read(buffer, 0, buffer.byteLength, chunk.offset);
      if (
        result.bytesRead !== buffer.byteLength ||
        createHash("sha256").update(buffer).digest("hex") !== chunk.sha256
      ) {
        fail("storage_error", "A saved chunk does not match its journal.");
      }
    } finally {
      await handle.close();
    }
  }

  async #exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key);
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.#locks.set(key, current);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#locks.get(key) === current) this.#locks.delete(key);
    }
  }
}

interface ChunkRecord {
  offset: number;
  bytes: number;
  sha256: string;
}

interface FileProgress {
  receivedBytes: number;
  chunks: ChunkRecord[];
}

type TransferRecord = z.infer<typeof recordSchema>;

function parseManifest(value: unknown, limits: ServerMigrationTransferLimits): ServerMigrationSnapshotManifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) fail("invalid_manifest", "The migration manifest has an invalid shape.");
  const input = result.data;
  if (
    Buffer.byteLength(JSON.stringify(input), "utf8") > limits.manifestBytes ||
    input.files.length > limits.fileCount
  ) {
    fail("capacity_exceeded", "The migration manifest exceeds its limit.");
  }
  if (!Number.isSafeInteger(input.totalBytes)) fail("invalid_manifest", "The manifest byte total is invalid.");
  const directories = new Set(input.directories);
  const files = new Map(input.files.map((file) => [file.path, file]));
  const missingAttachmentPathList = input.missingAttachmentPaths ?? [];
  const missingAttachmentPaths = new Set(missingAttachmentPathList);
  if (
    directories.size !== input.directories.length ||
    files.size !== input.files.length ||
    missingAttachmentPaths.size !== missingAttachmentPathList.length
  ) {
    fail("invalid_manifest", "The manifest contains duplicate paths.");
  }
  for (const path of missingAttachmentPaths) {
    if (!safePortableAttachmentPath(path)) {
      fail("invalid_manifest", "The manifest has a missing attachment outside the data allowlist.");
    }
    const relativePath = path.slice(PORTABLE_ATTACHMENT_PREFIX.length);
    if (files.has(`home/OpenBot/${relativePath}`)) {
      fail("invalid_manifest", "The manifest marks an included attachment as missing.");
    }
  }
  for (const path of directories) {
    if (!allowedDirectory(path)) fail("invalid_manifest", "The manifest has a directory outside the data allowlist.");
    if (parents(path).some((parent) => !directories.has(parent))) {
      fail("invalid_manifest", "The manifest omits a directory parent.");
    }
  }
  for (const file of input.files) {
    if (!allowedFile(file.path) || file.bytes > limits.fileBytes) {
      fail("invalid_manifest", "The manifest has a file outside the data allowlist.");
    }
    if (directories.has(file.path) || parents(file.path).some((parent) => !directories.has(parent))) {
      fail("invalid_manifest", "The manifest has an invalid file or parent path.");
    }
  }
  const total = input.files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(total) || total !== input.totalBytes)
    fail("invalid_manifest", "The manifest byte total is wrong.");
  if (total > limits.transferBytes) fail("capacity_exceeded", "The snapshot exceeds the transfer size limit.");
  if (REQUIRED_FILES.some((path) => !files.has(path))) fail("invalid_manifest", "A required database file is missing.");
  return {
    version: input.version,
    createdAt: input.createdAt,
    directories: [...directories].sort(),
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    missingAttachmentPaths: [...missingAttachmentPaths].sort((left, right) => left.localeCompare(right)),
    totalBytes: total,
  };
}

function safePortableAttachmentPath(path: string): boolean {
  if (!path.startsWith(PORTABLE_ATTACHMENT_PREFIX)) return false;
  const relativePath = path.slice(PORTABLE_ATTACHMENT_PREFIX.length);
  if (!safeRelativePath(relativePath)) return false;
  const segments = relativePath.split("/");
  return segments.length > 1 && ["Agents", "Bots", "Shared"].includes(segments[0] ?? "");
}

function allowedFile(path: string): boolean {
  if (!safeRelativePath(path)) return false;
  if (FIXED_FILES.has(path)) return true;
  const parent = path.slice(0, path.lastIndexOf("/"));
  const avatarDirectory = parent === "user-data/avatars/agents" || parent.startsWith("user-data/avatars/agents/");
  const serverLogoDirectory = ASSET_ROOTS.some((root) => parent === root || parent.startsWith(`${root}/`));
  if ((avatarDirectory || serverLogoDirectory) && ASSET_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  return WORKSPACE_ROOTS.some((root) => path.startsWith(`${root}/`));
}

function allowedDirectory(path: string): boolean {
  if (!safeRelativePath(path)) return false;
  return (
    ROOT_DIRECTORIES.has(path) ||
    path === "user-data/avatars" ||
    path === "user-data/avatars/agents" ||
    path.startsWith("user-data/avatars/agents/") ||
    ASSET_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)) ||
    WORKSPACE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
  );
}

function safeRelativePath(path: string): boolean {
  if (
    !path ||
    path.length > 4096 ||
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part.length > 255)
  )
    return false;
  return (
    relative(".", resolve(".", ...path.split("/")))
      .split(sep)
      .join("/") === path
  );
}

function parents(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function canonicalManifest(value: ServerMigrationSnapshotManifest): string {
  return JSON.stringify({
    version: value.version,
    createdAt: value.createdAt,
    directories: [...value.directories].sort(),
    files: [...value.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    ...(value.missingAttachmentPaths && value.missingAttachmentPaths.length > 0
      ? { missingAttachmentPaths: [...value.missingAttachmentPaths].sort((left, right) => left.localeCompare(right)) }
      : {}),
    totalBytes: value.totalBytes,
  });
}

function validateProgress(record: TransferRecord, limits: ServerMigrationTransferLimits): void {
  const manifestFiles = new Map(record.manifest.files.map((file) => [file.path, file]));
  if (
    Object.keys(record.progress).length !== manifestFiles.size ||
    Object.keys(record.progress).some((path) => !manifestFiles.has(path))
  )
    fail("storage_error", "Saved progress does not match the manifest.");
  let chunkCount = 0;
  for (const [path, progress] of Object.entries(record.progress)) {
    const expected = manifestFiles.get(path);
    if (!expected || progress.receivedBytes > expected.bytes) fail("storage_error", "Saved file progress is invalid.");
    let offset = 0;
    for (const chunk of progress.chunks) {
      if (
        chunk.offset !== offset ||
        chunk.bytes > limits.chunkBytes ||
        (offset + chunk.bytes < expected.bytes && chunk.bytes !== limits.chunkBytes)
      )
        fail("storage_error", "Saved chunk offsets are invalid.");
      offset += chunk.bytes;
      chunkCount += 1;
    }
    if (offset !== progress.receivedBytes) fail("storage_error", "Saved chunk totals are invalid.");
  }
  if (chunkCount > limits.chunkCount) fail("storage_error", "Saved chunk count exceeds its limit.");
}

function toStatus(record: TransferRecord): ServerMigrationTransferStatus {
  let receivedBytes = 0;
  const files = record.manifest.files.map((file) => {
    const received = record.progress[file.path]?.receivedBytes ?? 0;
    receivedBytes += received;
    return { path: file.path, bytes: file.bytes, receivedBytes: received, complete: received === file.bytes };
  });
  return { transferId: record.id, state: record.state, totalBytes: record.manifest.totalBytes, receivedBytes, files };
}

function validateLimits(limits: ServerMigrationTransferLimits): void {
  const values = Object.values(limits);
  if (
    values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    limits.chunkBytes > 16 * 1024 * 1024 ||
    limits.transferBytes > limits.retainedBytes ||
    limits.fileBytes > limits.transferBytes ||
    limits.transferCount > 16
  )
    throw new TypeError("The migration transfer limits are invalid.");
}

function compareDepth(a: string, b: string): number {
  return a.split("/").length - b.split("/").length || a.localeCompare(b);
}

function noFollow(): number {
  return constants.O_NOFOLLOW ?? 0;
}

async function writeNewFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAt(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer, offset: number): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(bytes, written, bytes.byteLength - written, offset + written);
    if (result.bytesWritten <= 0) fail("storage_error", "The migration chunk could not be written.");
    written += result.bytesWritten;
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("storage_error", "A staging path is not a real directory.");
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isExists(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
}

function isMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function assertId(value: string): void {
  if (!UUID.test(value)) fail("invalid_transfer", "The transfer id is invalid.");
}

function fail(code: ServerMigrationTransferFailureCode, message: string): never {
  throw new ServerMigrationTransferFailure({ code, message });
}

function toFailure(cause: unknown): ServerMigrationTransferFailure {
  if (cause instanceof ServerMigrationTransferFailure) return cause;
  if (cause instanceof ServerMigrationSnapshotError) {
    return new ServerMigrationTransferFailure({
      code: "verification_failed",
      message: "The migration snapshot could not be verified.",
    });
  }
  return new ServerMigrationTransferFailure({
    code: "storage_error",
    message: "The migration transfer could not be completed.",
  });
}
