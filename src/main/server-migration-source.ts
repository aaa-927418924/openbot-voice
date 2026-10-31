// The source side of `server-migration-v1`: build a portable snapshot of this local server,
// map its member identities to the destination host's members, upload the bytes, and let the
// destination promote them. The source keeps every file. Only this service's own staging copies
// are deleted, and only after the destination reports a completed activation.

import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TeamMemberSummary } from "@openbot/contracts/ipc";
import {
  SERVER_MIGRATION_CHUNK_BYTES_LIMIT,
  SERVER_MIGRATION_ROUTES,
} from "@openbot/contracts/team-protocol/server-migration-v1";
import { sourceText } from "@openbot/i18n/source";
import type { RemoteRequestInit } from "./remote-server-client";
import { remapMigratedMemberIdentities } from "./server-migration-identities";
import { createServerMigrationSnapshot, type ServerMigrationSnapshotManifest } from "./server-migration-snapshot";
import { decodeServerMigrationTransferStatus, decodeServerMigrationVerified } from "./server-migration-wire";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 60_000;

export type ServerMigrationPhase = "preparing" | "sending" | "finalizing" | "completed" | "cancelled" | "failed";

/** What the renderer shows for the one migration job. */
export interface ServerMigrationJobSnapshot {
  jobId: string;
  destinationServerId: string;
  destinationName: string;
  phase: ServerMigrationPhase;
  transferredBytes: number;
  totalBytes: number;
  /** Text from this process or the destination host, already safe to show. */
  message: string | null;
  retryable: boolean;
}

export interface ServerMigrationDestination {
  serverId: string;
  serverName: string;
}

/** One destination host, as the source needs it. The manager supplies the real transport. */
export interface ServerMigrationDestinationPeer {
  serverId: string;
  serverName: string;
  members: () => Promise<TeamMemberSummary[]>;
  request: <T>(path: string, decoder: (value: unknown) => T, init?: RemoteRequestInit) => Promise<T>;
  writeChunk: (input: {
    transferId: string;
    path: string;
    offset: number;
    bytes: Uint8Array<ArrayBuffer>;
  }) => Promise<ServerMigrationTransferStatus>;
}

export interface ServerMigrationTransferStatus {
  transferId: string;
  state: "receiving" | "paused" | "verified";
  totalBytes: number;
  receivedBytes: number;
  files: Array<{ path: string; bytes: number; receivedBytes: number; complete: boolean }>;
}

export interface ServerMigrationSourceOptions {
  /** This host's Electron userData directory. */
  userDataRoot: string;
  /** This host's `~/OpenBot` workspace directory. */
  openBotRoot: string;
  /** A private staging directory on this host. */
  stagingRoot: string;
  /** The members of this local host's team directory. */
  localMembers: () => readonly TeamMemberSummary[];
  /** The owner membership of this local host, when it has one. */
  localOwnerMemberId: () => string | null;
  destinations: () => ServerMigrationDestination[];
  peerFor: (serverId: string) => ServerMigrationDestinationPeer | null;
  onChange: (snapshot: ServerMigrationJobSnapshot) => void;
}

interface MigrationJob {
  id: string;
  destinationServerId: string;
  destinationName: string;
  phase: ServerMigrationPhase;
  transferredBytes: number;
  totalBytes: number;
  message: string | null;
  retryable: boolean;
  cancelled: boolean;
  running: boolean;
  snapshotPath: string | null;
  manifest: ServerMigrationSnapshotManifest | null;
  transferId: string | null;
}

export class ServerMigrationSourceService {
  readonly #options: ServerMigrationSourceOptions;
  #job: MigrationJob | null = null;

  constructor(options: ServerMigrationSourceOptions) {
    this.#options = options;
  }

  destinations(): ServerMigrationDestination[] {
    return this.#options.destinations();
  }

  state(): ServerMigrationJobSnapshot | null {
    return this.#job ? snapshotOf(this.#job) : null;
  }

  /** Starts one job. A second start replaces a finished job, never a running one. */
  start(destinationServerId: string): ServerMigrationJobSnapshot {
    if (this.#job?.running) throw new Error(sourceText("error.host.migrationBusy"));
    const destination = this.destinations().find((candidate) => candidate.serverId === destinationServerId);
    if (!destination) throw new Error(sourceText("error.host.migrationUnsupported"));
    const job: MigrationJob = {
      id: randomUUID(),
      destinationServerId,
      destinationName: destination.serverName,
      phase: "preparing",
      transferredBytes: 0,
      totalBytes: 0,
      message: null,
      retryable: false,
      cancelled: false,
      running: true,
      snapshotPath: null,
      manifest: null,
      transferId: null,
    };
    this.#job = job;
    this.#emit();
    void this.#run(job);
    return snapshotOf(job);
  }

  cancel(jobId: string): void {
    const job = this.#job;
    if (!job || job.id !== jobId || !job.running) return;
    job.cancelled = true;
  }

  /** Retries a failed job from its verified transfer, or starts again after a preparation failure. */
  retry(jobId: string): void {
    const job = this.#job;
    if (!job || job.id !== jobId || job.running) return;
    if (!job.retryable) return;
    job.running = true;
    job.cancelled = false;
    job.phase = job.manifest ? "sending" : "preparing";
    job.message = null;
    job.retryable = false;
    this.#emit();
    void this.#run(job);
  }

  async #run(job: MigrationJob): Promise<void> {
    try {
      const peer = this.#options.peerFor(job.destinationServerId);
      if (!peer) throw new Error(sourceText("error.host.migrationUnsupported"));
      if (!job.manifest || !job.snapshotPath) {
        await this.#snapshot(job, peer);
      }
      if (this.#stopIfCancelled(job, peer)) return;
      if (!job.transferId) {
        await this.#begin(job, peer);
      }
      if (this.#stopIfCancelled(job, peer)) return;
      await this.#upload(job, peer);
      if (this.#stopIfCancelled(job, peer)) return;
      job.phase = "finalizing";
      this.#emit();
      await peer.request(SERVER_MIGRATION_ROUTES.finalize, decodeServerMigrationVerified, {
        method: "POST",
        body: { transferId: job.transferId },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      job.phase = "completed";
      job.transferredBytes = job.totalBytes;
      job.running = false;
      this.#emit();
      // Only this process's own snapshot copy is removed. The local server data is untouched.
      if (job.snapshotPath) await rm(job.snapshotPath, { recursive: true, force: true }).catch(() => undefined);
      job.snapshotPath = null;
    } catch (error) {
      if (job.cancelled) {
        job.phase = "cancelled";
        job.message = sourceText("error.host.migrationCancelled");
        job.running = false;
        job.retryable = true;
        this.#emit();
        return;
      }
      job.phase = "failed";
      job.message = messageOf(error);
      job.running = false;
      job.retryable = true;
      this.#emit();
    }
  }

  async #snapshot(job: MigrationJob, peer: ServerMigrationDestinationPeer): Promise<void> {
    job.phase = "preparing";
    this.#emit();
    const destinationMembers = await peer.members();
    const memberMap = buildMemberIdMap(
      this.#options.localOwnerMemberId(),
      this.#options.localMembers(),
      destinationMembers,
    );
    await mkdir(this.#options.stagingRoot, { recursive: true, mode: 0o700 });
    const snapshotPath = join(this.#options.stagingRoot, `snapshot-${job.id}`);
    await rm(snapshotPath, { recursive: true, force: true });
    const snapshot = await createServerMigrationSnapshot({
      userDataRoot: this.#options.userDataRoot,
      openBotRoot: this.#options.openBotRoot,
      destinationPath: snapshotPath,
      rewriteUserDatabase: (databasePath) => {
        const database = new DatabaseSync(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
        try {
          remapMigratedMemberIdentities(database, memberMap);
        } finally {
          database.close();
        }
      },
    });
    job.snapshotPath = snapshot.path;
    job.manifest = snapshot.manifest;
    job.totalBytes = snapshot.manifest.totalBytes;
    this.#emit();
  }

  async #begin(job: MigrationJob, peer: ServerMigrationDestinationPeer): Promise<void> {
    if (!job.manifest) throw new Error(sourceText("error.host.migrationSnapshotFailed"));
    const begin = await peer.request(SERVER_MIGRATION_ROUTES.begin, decodeServerMigrationTransferStatus, {
      method: "POST",
      body: { requestId: job.id, manifest: job.manifest },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    job.transferId = begin.transferId;
    job.transferredBytes = begin.receivedBytes;
    this.#emit();
  }

  async #upload(job: MigrationJob, peer: ServerMigrationDestinationPeer): Promise<void> {
    const manifest = job.manifest;
    if (!manifest || !job.snapshotPath || !job.transferId) {
      throw new Error(sourceText("error.host.migrationTransferFailed"));
    }
    job.phase = "sending";
    this.#emit();
    const status = await peer.request(
      `${SERVER_MIGRATION_ROUTES.status}?transferId=${encodeURIComponent(job.transferId)}`,
      decodeServerMigrationTransferStatus,
      { method: "GET", timeoutMs: REQUEST_TIMEOUT_MS },
    );
    // A cancelled job leaves the destination paused with its received bytes. A retry resumes the
    // same transfer so the destination accepts chunks again.
    if (status.state === "paused") {
      await peer.request(SERVER_MIGRATION_ROUTES.resume, decodeServerMigrationTransferStatus, {
        method: "POST",
        body: { transferId: job.transferId },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
    const receivedByPath = new Map(status.files.map((file) => [file.path, file.receivedBytes]));
    job.transferredBytes = 0;
    for (const file of manifest.files) {
      if (this.#stopIfCancelled(job, peer)) return;
      const received = Math.min(receivedByPath.get(file.path) ?? 0, file.bytes);
      job.transferredBytes += received;
      this.#emit();
      if (received === file.bytes) continue;
      const handle = await open(join(job.snapshotPath, ...file.path.split("/")), "r");
      try {
        for (let offset = received; offset < file.bytes; offset += SERVER_MIGRATION_CHUNK_BYTES_LIMIT) {
          if (job.cancelled) return;
          const length = Math.min(SERVER_MIGRATION_CHUNK_BYTES_LIMIT, file.bytes - offset);
          const bytes = new Uint8Array(new ArrayBuffer(length));
          const read = await handle.read(bytes, 0, length, offset);
          if (read.bytesRead !== length) {
            throw new Error(sourceText("error.host.migrationSnapshotFailed"));
          }
          await peer.writeChunk({
            transferId: job.transferId,
            path: file.path,
            offset,
            bytes,
          });
          job.transferredBytes += length;
          this.#emit();
        }
      } finally {
        await handle.close();
      }
    }
  }

  #stopIfCancelled(job: MigrationJob, peer: ServerMigrationDestinationPeer): boolean {
    if (!job.cancelled) return false;
    if (job.transferId) {
      // The host keeps the received bytes for a retry.
      void peer
        .request(SERVER_MIGRATION_ROUTES.pause, decodeServerMigrationTransferStatus, {
          method: "POST",
          body: { transferId: job.transferId },
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        .catch(() => undefined);
    }
    job.phase = "cancelled";
    job.message = sourceText("error.host.migrationCancelled");
    job.running = false;
    job.retryable = true;
    this.#emit();
    return true;
  }

  #emit(): void {
    if (this.#job) this.#options.onChange(snapshotOf(this.#job));
  }
}

function snapshotOf(job: MigrationJob): ServerMigrationJobSnapshot {
  return {
    jobId: job.id,
    destinationServerId: job.destinationServerId,
    destinationName: job.destinationName,
    phase: job.phase,
    transferredBytes: job.transferredBytes,
    totalBytes: job.totalBytes,
    message: job.message,
    retryable: job.retryable,
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return sourceText("error.host.migrationTransferFailed");
}

/**
 * The owner becomes the destination owner. Every other member is matched by email. A member with
 * no destination counterpart stays under the source identity, which no destination member holds.
 */
export function buildMemberIdMap(
  sourceOwnerMemberId: string | null,
  sourceMembers: readonly TeamMemberSummary[],
  destinationMembers: readonly TeamMemberSummary[],
): Map<string, string> {
  const mapping = new Map<string, string>();
  const destinationOwner = destinationMembers.find((member) => member.role === "owner");
  if (sourceOwnerMemberId && destinationOwner) mapping.set(sourceOwnerMemberId, destinationOwner.id);
  for (const member of sourceMembers) {
    if (member.role === "owner" || member.id === sourceOwnerMemberId) continue;
    const email = member.email?.trim().toLowerCase();
    if (!email) continue;
    const target = destinationMembers.find((candidate) => candidate.email?.trim().toLowerCase() === email);
    if (target) mapping.set(member.id, target.id);
  }
  return mapping;
}
