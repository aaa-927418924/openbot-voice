import { verify } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AccountServerDirectoryEntry,
  AccountServerRegistration,
  AccountServerVisibilityProof,
} from "@openbot/contracts/account-server-directory";
import { accountServerVisibilityPayload } from "@openbot/contracts/account-server-directory";
import { isTailscaleApiUrl } from "@openbot/contracts/invite-links";
import type { TeamRole } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { remoteHostFingerprint } from "@openbot/team-client/remote-directory";
import { Effect } from "effect";
import lockDirectoryModule from "proper-lockfile";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";

interface DirectoryLockOptions {
  readonly realpath: false;
  readonly stale: number;
  readonly update: number;
  readonly retries: { readonly retries: number; readonly minTimeout: number; readonly maxTimeout: number };
}

type DirectoryLockRelease = () => Promise<void>;
type DirectoryLock = (path: string, options: DirectoryLockOptions) => Promise<DirectoryLockRelease>;

// Import statically so both Electron and the standalone Bun server binary bundle this dependency.
const lockDirectory: DirectoryLock = lockDirectoryModule;

interface StoredServer {
  readonly hostId: string;
  readonly name: string;
  readonly apiUrl: string;
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly logoKey: string | null;
}

interface StoredMembership {
  readonly accountId: string;
  readonly hostId: string;
  readonly membershipId: string;
  readonly role: TeamRole;
}

interface RemovedMembership {
  readonly accountId: string;
  readonly hostId: string;
}

interface DirectoryFile {
  readonly version: 4;
  readonly servers: readonly StoredServer[];
  readonly memberships: readonly StoredMembership[];
  /** Hidden hosts stay stored for reversible, account-wide removal from server lists. */
  readonly hiddenHostIds: readonly string[];
  /** Explicit account-level leaves prevent another device's old cache from re-adding membership. */
  readonly removedMemberships: readonly RemovedMembership[];
}

function emptyDirectory(): DirectoryFile {
  return { version: 4, servers: [], memberships: [], hiddenHostIds: [], removedMemberships: [] };
}

function validId(value: unknown): value is string {
  return isString(value) && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function validRole(value: unknown): value is TeamRole {
  return value === "owner" || value === "admin" || value === "member";
}

function decodeServer(value: unknown): StoredServer {
  if (
    !isDynamicRecord(value) ||
    !validId(value.hostId) ||
    !isString(value.name) ||
    value.name.trim().length === 0 ||
    value.name.length > 128 ||
    !isString(value.apiUrl) ||
    !isTailscaleApiUrl(value.apiUrl) ||
    !isString(value.fingerprint) ||
    !isString(value.publicKey) ||
    value.publicKey.length > 8192 ||
    remoteHostFingerprint(value.publicKey) !== value.fingerprint ||
    !(value.logoKey === null || (isString(value.logoKey) && value.logoKey.length <= 256))
  ) {
    throw new Error("The account server directory is invalid.");
  }
  return {
    hostId: value.hostId,
    name: value.name,
    apiUrl: value.apiUrl,
    fingerprint: value.fingerprint,
    publicKey: value.publicKey,
    logoKey: value.logoKey,
  };
}

function decodeMembership(value: unknown): StoredMembership {
  if (
    !isDynamicRecord(value) ||
    !validId(value.accountId) ||
    !validId(value.hostId) ||
    !validId(value.membershipId) ||
    !validRole(value.role)
  ) {
    throw new Error("The account server directory is invalid.");
  }
  return {
    accountId: value.accountId,
    hostId: value.hostId,
    membershipId: value.membershipId,
    role: value.role,
  };
}

function decodeHiddenHostIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("The account server directory is invalid.");
  const hostIds: string[] = [];
  for (const hostId of value) {
    if (!validId(hostId)) throw new Error("The account server directory is invalid.");
    hostIds.push(hostId);
  }
  if (new Set(hostIds).size !== hostIds.length) throw new Error("The account server directory is invalid.");
  return hostIds;
}

function decodeRemovedMemberships(value: unknown): RemovedMembership[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("The account server directory is invalid.");
  const removed = value.map((entry) => {
    if (!isDynamicRecord(entry) || !validId(entry.accountId) || !validId(entry.hostId)) {
      throw new Error("The account server directory is invalid.");
    }
    return { accountId: entry.accountId, hostId: entry.hostId };
  });
  if (new Set(removed.map(({ accountId, hostId }) => `${accountId}\0${hostId}`)).size !== removed.length) {
    throw new Error("The account server directory is invalid.");
  }
  return removed;
}

function decodeDirectory(value: unknown): DirectoryFile {
  if (
    !isDynamicRecord(value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) ||
    !Array.isArray(value.servers) ||
    value.servers.length > 10_000 ||
    !Array.isArray(value.memberships) ||
    value.memberships.length > 50_000
  ) {
    throw new Error("The account server directory is invalid.");
  }
  const servers = value.servers.map(decodeServer);
  const memberships = value.memberships.map(decodeMembership);
  const serverIds = new Set(servers.map((server) => server.hostId));
  const membershipIds = new Set(memberships.map(({ accountId, hostId }) => `${accountId}\0${hostId}`));
  if (
    serverIds.size !== servers.length ||
    membershipIds.size !== memberships.length ||
    memberships.some((membership) => !serverIds.has(membership.hostId))
  ) {
    throw new Error("The account server directory is invalid.");
  }
  const hiddenHostIds = decodeHiddenHostIds(value.hiddenHostIds);
  const removedMemberships = decodeRemovedMemberships(value.removedMemberships);
  return { version: 4, servers, memberships, hiddenHostIds, removedMemberships };
}

function decodeRegistration(value: unknown): AccountServerRegistration {
  if (
    !isDynamicRecord(value) ||
    !validId(value.membershipId) ||
    !validRole(value.role) ||
    (value.legacyImport !== undefined && typeof value.legacyImport !== "boolean") ||
    (value.rejoin !== undefined && typeof value.rejoin !== "boolean")
  ) {
    throw new AccountServerDirectoryError(400, "invalid_request");
  }
  let server: StoredServer;
  try {
    server = decodeServer(value);
  } catch {
    throw new AccountServerDirectoryError(400, "invalid_request");
  }
  return {
    hostId: server.hostId,
    name: server.name,
    apiUrl: server.apiUrl,
    fingerprint: server.fingerprint,
    publicKey: server.publicKey,
    logoKey: server.logoKey,
    membershipId: value.membershipId,
    role: value.role,
    ...(value.legacyImport === true ? { legacyImport: true } : {}),
    ...(value.rejoin === true ? { rejoin: true } : {}),
  };
}

/**
 * Cross-device server metadata owned by the signed-in account service. Per-device Team session
 * tokens intentionally stay in each device's secure store and are never written here.
 */
export class SelfHostedAccountServerDirectory {
  readonly #path: string;
  #state = emptyDirectory();
  #initialized = false;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async initialize(): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#initialized) return;
      this.#state = await this.#readDirectory();
      this.#initialized = true;
    });
  }

  async list(accountId: string): Promise<AccountServerDirectoryEntry[]> {
    return this.#exclusive(async () => {
      await this.#requireReady();
      this.#state = await this.#readDirectory();
      return this.#listFromState(accountId);
    });
  }

  #listFromState(accountId: string): AccountServerDirectoryEntry[] {
    const hiddenHostIds = new Set(this.#state.hiddenHostIds);
    return this.#state.memberships
      .filter((membership) => membership.accountId === accountId && !hiddenHostIds.has(membership.hostId))
      .flatMap((membership) => {
        const server = this.#state.servers.find((candidate) => candidate.hostId === membership.hostId);
        return server
          ? [
              {
                hostId: server.hostId,
                name: server.name,
                apiUrl: server.apiUrl,
                fingerprint: server.fingerprint,
                publicKey: server.publicKey,
                logoKey: server.logoKey,
                membershipId: membership.membershipId,
                role: membership.role,
                // The synced directory is not an authority for Team server permissions.
                isOwner: false,
              },
            ]
          : [];
      });
  }

  async legacyImportExclusions(accountId: string): Promise<string[]> {
    return this.#exclusive(async () => {
      await this.#requireReady();
      this.#state = await this.#readDirectory();
      return this.#legacyImportExclusionsFromState(accountId);
    });
  }

  #legacyImportExclusionsFromState(accountId: string): string[] {
    return [
      ...new Set([
        ...this.#state.hiddenHostIds,
        ...this.#state.removedMemberships
          .filter((membership) => membership.accountId === accountId)
          .map(({ hostId }) => hostId),
      ]),
    ];
  }

  async register(accountId: string, input: unknown): Promise<AccountServerDirectoryEntry[]> {
    const registration = decodeRegistration(input);
    return this.#mutate(async () => {
      const removed = this.#state.removedMemberships.some(
        (membership) => membership.accountId === accountId && membership.hostId === registration.hostId,
      );
      const hidden = this.#state.hiddenHostIds.includes(registration.hostId);
      // Old clients and background metadata refreshes omit both markers. Neither may silently
      // undo an explicit account leave. Only a fresh invite/QR pairing opts into rejoining.
      if (hidden || (removed && !registration.rejoin)) {
        return this.#listFromState(accountId);
      }
      const existing = this.#state.servers.find((server) => server.hostId === registration.hostId);
      if (
        existing &&
        (existing.fingerprint !== registration.fingerprint ||
          existing.publicKey !== registration.publicKey ||
          existing.apiUrl !== registration.apiUrl)
      ) {
        throw new AccountServerDirectoryError(409, "host_identity_conflict");
      }
      const server: StoredServer = existing
        ? { ...existing, name: registration.name, logoKey: registration.logoKey }
        : {
            hostId: registration.hostId,
            name: registration.name,
            apiUrl: registration.apiUrl,
            fingerprint: registration.fingerprint,
            publicKey: registration.publicKey,
            logoKey: registration.logoKey,
          };
      const membership: StoredMembership = {
        accountId,
        hostId: registration.hostId,
        membershipId: registration.membershipId,
        role: registration.role,
      };
      const next: DirectoryFile = {
        version: 4,
        servers: existing
          ? this.#state.servers.map((candidate) => (candidate.hostId === server.hostId ? server : candidate))
          : [...this.#state.servers, server],
        memberships: this.#state.memberships.some(
          (candidate) => candidate.accountId === accountId && candidate.hostId === server.hostId,
        )
          ? this.#state.memberships.map((candidate) =>
              candidate.accountId === accountId && candidate.hostId === server.hostId ? membership : candidate,
            )
          : [...this.#state.memberships, membership],
        hiddenHostIds: this.#state.hiddenHostIds,
        removedMemberships: registration.rejoin
          ? this.#state.removedMemberships.filter(
              (membership) => !(membership.accountId === accountId && membership.hostId === server.hostId),
            )
          : this.#state.removedMemberships,
      };
      await this.#persist(next);
      this.#state = next;
      return this.#listFromState(accountId);
    });
  }

  /**
   * Refreshes the signed-in owner's own live host metadata. Unlike invite registration, the host
   * identity key stays fixed while a Tailscale address may change. This method is only called by
   * the trusted local identity API after it verifies host ownership. It never clears hide/leave
   * tombstones.
   */
  async syncLocalOwnerRegistration(accountId: string, input: unknown): Promise<AccountServerDirectoryEntry[]> {
    const registration = decodeRegistration(input);
    return this.#mutate(async () => {
      const removed = this.#state.removedMemberships.some(
        (membership) => membership.accountId === accountId && membership.hostId === registration.hostId,
      );
      if (removed || this.#state.hiddenHostIds.includes(registration.hostId)) return this.#listFromState(accountId);

      const existing = this.#state.servers.find((server) => server.hostId === registration.hostId);
      if (
        existing &&
        (existing.fingerprint !== registration.fingerprint || existing.publicKey !== registration.publicKey)
      ) {
        throw new AccountServerDirectoryError(409, "host_identity_conflict");
      }
      const server: StoredServer = {
        hostId: registration.hostId,
        name: registration.name,
        apiUrl: registration.apiUrl,
        fingerprint: registration.fingerprint,
        publicKey: registration.publicKey,
        logoKey: registration.logoKey,
      };
      const membership: StoredMembership = {
        accountId,
        hostId: registration.hostId,
        membershipId: registration.membershipId,
        // The Team host remains the permission authority. Account-directory sync never grants
        // elevated privileges, even when this account owns the local host process.
        role: "member",
      };
      const existingMembership = this.#state.memberships.find(
        (candidate) => candidate.accountId === accountId && candidate.hostId === registration.hostId,
      );
      if (
        existing?.name === server.name &&
        existing.apiUrl === server.apiUrl &&
        existing.logoKey === server.logoKey &&
        existingMembership?.membershipId === membership.membershipId &&
        existingMembership.role === membership.role
      ) {
        return this.#listFromState(accountId);
      }
      const next: DirectoryFile = {
        ...this.#state,
        version: 4,
        servers: existing
          ? this.#state.servers.map((candidate) => (candidate.hostId === server.hostId ? server : candidate))
          : [...this.#state.servers, server],
        memberships: existingMembership
          ? this.#state.memberships.map((candidate) =>
              candidate.accountId === accountId && candidate.hostId === server.hostId ? membership : candidate,
            )
          : [...this.#state.memberships, membership],
      };
      await this.#persist(next);
      this.#state = next;
      return this.#listFromState(accountId);
    });
  }

  /**
   * Hides a host from every account served by this identity directory without deleting memberships,
   * Team conversations, attachments, or workspaces. The owning host process calls this operation;
   * re-enabling it simply removes the host from this set.
   */
  async setServerVisible(hostId: string, visible: boolean): Promise<void> {
    if (!validId(hostId)) throw new AccountServerDirectoryError(400, "invalid_request");
    await this.#mutate(async () => {
      const hiddenHostIds = new Set(this.#state.hiddenHostIds);
      const wasHidden = hiddenHostIds.has(hostId);
      if (visible) hiddenHostIds.delete(hostId);
      else hiddenHostIds.add(hostId);
      if (wasHidden === !visible) return;
      const next: DirectoryFile = { ...this.#state, version: 4, hiddenHostIds: [...hiddenHostIds] };
      await this.#persist(next);
      this.#state = next;
    });
  }

  async setServerVisibleWithOwnerProof(accountId: string, proof: AccountServerVisibilityProof): Promise<void> {
    if (
      !validId(accountId) ||
      !validId(proof.hostId) ||
      typeof proof.visible !== "boolean" ||
      !/^[A-Za-z0-9_-]{16,128}$/u.test(proof.nonce) ||
      !/^[A-Za-z0-9_-]{86}$/u.test(proof.signature)
    ) {
      throw new AccountServerDirectoryError(400, "invalid_request");
    }
    await this.#mutate(async () => {
      const server = this.#state.servers.find((candidate) => candidate.hostId === proof.hostId);
      if (!server) return;
      const membership = this.#state.memberships.find(
        (candidate) => candidate.accountId === accountId && candidate.hostId === proof.hostId,
      );
      if (!membership) throw new AccountServerDirectoryError(404, "not_found");
      let validProof = false;
      try {
        validProof = verify(
          null,
          Buffer.from(accountServerVisibilityPayload(accountId, proof), "utf8"),
          server.publicKey,
          Buffer.from(proof.signature, "base64url"),
        );
      } catch {
        validProof = false;
      }
      if (!validProof) throw new AccountServerDirectoryError(403, "forbidden");

      const hiddenHostIds = new Set(this.#state.hiddenHostIds);
      const wasHidden = hiddenHostIds.has(proof.hostId);
      if (proof.visible) hiddenHostIds.delete(proof.hostId);
      else hiddenHostIds.add(proof.hostId);
      if (wasHidden === !proof.visible) return;
      const next: DirectoryFile = { ...this.#state, version: 4, hiddenHostIds: [...hiddenHostIds] };
      await this.#persist(next);
      this.#state = next;
    });
  }

  async removeMembership(accountId: string, hostId: string): Promise<void> {
    if (!validId(hostId)) throw new AccountServerDirectoryError(400, "invalid_request");
    await this.#mutate(async () => {
      const memberships = this.#state.memberships.filter(
        (membership) => !(membership.accountId === accountId && membership.hostId === hostId),
      );
      const removedMemberships = this.#state.removedMemberships.some(
        (membership) => membership.accountId === accountId && membership.hostId === hostId,
      )
        ? this.#state.removedMemberships
        : [...this.#state.removedMemberships, { accountId, hostId }];
      const referencedHosts = new Set(memberships.map((membership) => membership.hostId));
      const servers = this.#state.servers.filter((server) => referencedHosts.has(server.hostId));
      const next: DirectoryFile = {
        version: 4,
        servers,
        memberships,
        // A hidden local host may not have a directory membership. Keep that global tombstone
        // independent from membership cleanup so stale device caches cannot import it again.
        hiddenHostIds: this.#state.hiddenHostIds,
        removedMemberships,
      };
      if (
        next.memberships.length === this.#state.memberships.length &&
        next.removedMemberships.length === this.#state.removedMemberships.length
      )
        return;
      await this.#persist(next);
      this.#state = next;
    });
  }

  async #requireReady(): Promise<void> {
    if (!this.#initialized) throw new Error("The account server directory is unavailable.");
  }

  async #readDirectory(): Promise<DirectoryFile> {
    try {
      return decodeDirectory(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return emptyDirectory();
      }
      throw new Error("The account server directory could not be read.");
    }
  }

  #mutate<A>(operation: () => Promise<A>): Promise<A> {
    return this.#exclusive(() =>
      this.#withDirectoryLock(async () => {
        await this.#requireReady();
        // The CLI and desktop can use the same profile directory in separate processes. Reload only
        // after acquiring the shared file lock so a stale in-memory snapshot cannot erase the other
        // process's registrations, hides, or leaves.
        this.#state = await this.#readDirectory();
        return operation();
      }),
    );
  }

  async #withDirectoryLock<A>(operation: () => Promise<A>): Promise<A> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    let release: DirectoryLockRelease;
    try {
      release = await lockDirectory(this.#path, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: { retries: 40, minTimeout: 25, maxTimeout: 125 },
      });
    } catch {
      throw new Error("The account server directory is busy and could not be locked.");
    }
    try {
      return await operation();
    } finally {
      await release().catch(() => {
        throw new Error("The account server directory lock could not be released.");
      });
    }
  }

  async #persist(next: DirectoryFile): Promise<void> {
    try {
      await Effect.runPromise(writeJsonFileAtomically(this.#path, next, { createDirectory: true }));
    } catch {
      throw new Error("The account server directory could not be saved.");
    }
  }

  #exclusive<A>(operation: () => Promise<A>): Promise<A> {
    const result = this.#writeTail.then(operation);
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class AccountServerDirectoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
