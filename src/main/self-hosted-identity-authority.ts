import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { isAvatarMimeType, isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { AVATAR_IMAGE_LIMITS } from "@openbot/contracts/input-limits";
import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { validateProfileName } from "@openbot/contracts/validation";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result, Schema, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const TEAM_TICKET_TTL_MS = 2 * 60 * 1_000;
const MAX_SESSIONS = 256;
const MAX_PENDING_TICKETS = 1_024;
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TEAM_SERVER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export class SelfHostedIdentityFailure extends Schema.TaggedError<SelfHostedIdentityFailure>()(
  "SelfHostedIdentityFailure",
  {
    code: Schema.Literals([
      "not_initialized",
      "storage_unavailable",
      "setup_completed",
      "loopback_required",
      "invalid_input",
      "invalid_credentials",
      "session_limit",
      "invalid_session",
      "invalid_ticket",
      "internal_failure",
    ]),
  },
) {}

export type SelfHostedIdentityFailureCode = SelfHostedIdentityFailure["code"];

export interface LocalProfileBootstrap {
  /** The ID returned by LocalProfileStore.getUser(). It remains the canonical account ID. */
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

export type SelfHostedAccount = Pick<CentralAuthUser, "id" | "name" | "avatarUrl"> & {
  readonly username: string;
};

export interface SelfHostedSessionGrant {
  readonly account: SelfHostedAccount;
  /** Return this value once to the client. The authority stores only its SHA-256 hash. */
  readonly token: string;
  readonly expiresAt: number;
}

export interface SelfHostedTeamTicketGrant {
  /** Return this value once to the client. The authority stores only its SHA-256 hash. */
  readonly ticket: string;
  readonly expiresAt: number;
}

interface StoredAccount {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly passwordSalt: string;
  readonly passwordHash: string;
  readonly createdAt: number;
}

interface StoredSession {
  readonly id: string;
  readonly accountId: string;
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface StoredTeamTicket {
  readonly tokenHash: string;
  readonly accountId: string;
  readonly targetTeamServerId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface IdentityFile {
  readonly version: 1;
  readonly accounts: readonly StoredAccount[];
  readonly sessions: readonly StoredSession[];
  readonly teamTickets: readonly StoredTeamTicket[];
}

interface AuthorityOptions {
  readonly path: string;
  readonly now?: () => number;
}

const storedAccountSchema = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  passwordSalt: Schema.String,
  passwordHash: Schema.String,
  createdAt: Schema.Number,
});
const storedSessionSchema = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  tokenHash: Schema.String,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
});
const storedTeamTicketSchema = Schema.Struct({
  tokenHash: Schema.String,
  accountId: Schema.String,
  targetTeamServerId: Schema.String,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
});

function decodeIdentityFile(value: unknown): IdentityFile {
  if (!isDynamicRecord(value) || value.version !== 1 || !Array.isArray(value.accounts)) {
    throw new Error("The identity authority file is invalid.");
  }
  if (value.accounts.length > 1 || !Array.isArray(value.sessions) || !Array.isArray(value.teamTickets)) {
    throw new Error("The identity authority file is invalid.");
  }

  const accounts = value.accounts.map((entry) => decodeAccount(entry));
  const accountIds = new Set(accounts.map((account) => account.id));
  const sessions = value.sessions.map((entry) => decodeSession(entry));
  const teamTickets = value.teamTickets.map((entry) => decodeTeamTicket(entry));
  if (
    sessions.length > MAX_SESSIONS ||
    teamTickets.length > MAX_PENDING_TICKETS ||
    sessions.some((session) => !accountIds.has(session.accountId)) ||
    teamTickets.some((ticket) => !accountIds.has(ticket.accountId))
  ) {
    throw new Error("The identity authority file is invalid.");
  }
  return { version: 1, accounts, sessions, teamTickets };
}

function decodeAccount(value: unknown): StoredAccount {
  const parsed = Schema.decodeUnknownSync(storedAccountSchema)(value);
  const name = validateProfileName(parsed.name);
  if (
    !validAccountId(parsed.id) ||
    normalizeUsername(parsed.username) !== parsed.username ||
    name.error ||
    !/^[A-Za-z0-9_-]{22}$/.test(parsed.passwordSalt) ||
    !/^[A-Za-z0-9_-]{86}$/.test(parsed.passwordHash) ||
    !Number.isSafeInteger(parsed.createdAt) ||
    parsed.createdAt < 0
  ) {
    throw new Error("The identity authority account is invalid.");
  }
  const avatarUrl = normalizeAvatarUrl(parsed.avatarUrl);
  return { ...parsed, name: name.name, avatarUrl };
}

function decodeSession(value: unknown): StoredSession {
  const parsed = Schema.decodeUnknownSync(storedSessionSchema)(value);
  if (
    !validAccountId(parsed.id) ||
    !validAccountId(parsed.accountId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.tokenHash) ||
    !validExpiry(parsed.createdAt, parsed.expiresAt)
  ) {
    throw new Error("The identity authority session is invalid.");
  }
  return parsed;
}

function decodeTeamTicket(value: unknown): StoredTeamTicket {
  const parsed = Schema.decodeUnknownSync(storedTeamTicketSchema)(value);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.tokenHash) ||
    !validAccountId(parsed.accountId) ||
    !TEAM_SERVER_ID_PATTERN.test(parsed.targetTeamServerId) ||
    !validExpiry(parsed.createdAt, parsed.expiresAt)
  ) {
    throw new Error("The identity authority ticket is invalid.");
  }
  return parsed;
}

function validExpiry(createdAt: number, expiresAt: number): boolean {
  return Number.isSafeInteger(createdAt) && createdAt >= 0 && Number.isSafeInteger(expiresAt) && expiresAt > createdAt;
}

function validAccountId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && value.trim() === value;
}

function normalizeUsername(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

function normalizeAvatarUrl(value: string | null): string | null {
  if (value === null) return null;
  const maxBase64Length = Math.ceil(AVATAR_IMAGE_LIMITS.storedBytes / 3) * 4;
  if (value.length > maxBase64Length + 64) throw new Error("The local profile avatar is invalid.");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  const mimeType = match?.[1];
  const base64 = match?.[2];
  if (!mimeType || !base64 || !isAvatarMimeType(mimeType)) throw new Error("The local profile avatar is invalid.");
  const bytes = Buffer.from(base64, "base64");
  if (!isValidAvatarImage(mimeType, bytes)) throw new Error("The local profile avatar is invalid.");
  if (bytes.toString("base64") !== base64) throw new Error("The local profile avatar is invalid.");
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function isLoopbackAddress(remoteAddress: string): boolean {
  const address = remoteAddress.toLowerCase();
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(address)?.[1];
  const candidate = mappedIpv4 ?? address;
  if (isIP(candidate) === 4) return candidate.split(".")[0] === "127";
  return candidate === "::1" || candidate === "0:0:0:0:0:0:0:1";
}

function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function safePasswordEqual(candidate: Uint8Array, expectedBase64Url: string): boolean {
  const expected = Buffer.from(expectedBase64Url, "base64url");
  const candidateBytes = Buffer.from(candidate);
  return candidateBytes.length === expected.length && timingSafeEqual(candidateBytes, expected);
}

function derivePassword(password: string, salt: string): Effect.Effect<Buffer, SelfHostedIdentityFailure> {
  return Effect.tryPromise({
    try: () =>
      new Promise<Buffer>((resolve, reject) => {
        scryptCallback(password, salt, 64, (error, derivedKey) => {
          if (error) reject(error);
          else resolve(derivedKey);
        });
      }),
    catch: () => failure("internal_failure"),
  });
}

function publicAccount(account: StoredAccount): SelfHostedAccount {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    avatarUrl: account.avatarUrl,
  };
}

function failure(code: SelfHostedIdentityFailureCode): SelfHostedIdentityFailure {
  return new SelfHostedIdentityFailure({ code });
}

function emptyIdentityFile(): IdentityFile {
  return { version: 1, accounts: [], sessions: [], teamTickets: [] };
}

/**
 * A private, single-account authority for the self-hosted control plane.
 *
 * This service owns account identity only. TeamStore and conversation data stay in each host's own
 * files and database. The first-account operation checks the request socket address itself; its
 * future HTTP adapter must pass `request.socket.remoteAddress`, not a forwarded header.
 */
export class SelfHostedIdentityAuthority {
  readonly #path: string;
  readonly #now: () => number;
  readonly #writes = Semaphore.makeUnsafe(1);
  #file: IdentityFile = emptyIdentityFile();
  #initialized = false;
  #unavailable = false;

  constructor(options: AuthorityOptions) {
    this.#path = options.path;
    this.#now = options.now ?? Date.now;
  }

  readonly initialize = Effect.fn("SelfHostedIdentityAuthority.initialize")(function* (
    this: SelfHostedIdentityAuthority,
  ): Effect.fn.Return<void, SelfHostedIdentityFailure> {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.#initialized) return;
        const loaded = yield* Effect.result(readPreferenceFile(this.#path, decodeIdentityFile));
        if (Result.isSuccess(loaded)) {
          this.#file = loaded.success;
          this.#initialized = true;
          this.#unavailable = false;
          return;
        }
        if (isMissingFileError(loaded.failure.cause)) {
          this.#file = emptyIdentityFile();
          this.#initialized = true;
          this.#unavailable = false;
          return;
        }
        this.#unavailable = true;
        return yield* failure("storage_unavailable");
      }),
    );
  });

  /**
   * Create the one canonical account from the authority PC's existing LocalProfileStore profile.
   * The socket address must be a loopback address. The account ID, name, and avatar are retained.
   */
  readonly bootstrapFirstAccount = Effect.fn("SelfHostedIdentityAuthority.bootstrapFirstAccount")(function* (
    this: SelfHostedIdentityAuthority,
    input: {
      readonly remoteAddress: string;
      readonly username: string;
      readonly password: string;
      readonly profile: LocalProfileBootstrap;
    },
  ): Effect.fn.Return<SelfHostedAccount, SelfHostedIdentityFailure> {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* this.#requireReady();
        if (!isString(input?.remoteAddress) || !isLoopbackAddress(input.remoteAddress)) {
          return yield* failure("loopback_required");
        }
        if (this.#file.accounts.length > 0) return yield* failure("setup_completed");

        const profile = input?.profile;
        const username = isString(input?.username) ? normalizeUsername(input.username) : null;
        const name = isDynamicRecord(profile) && isString(profile.name) ? validateProfileName(profile.name) : null;
        let avatarUrl: string | null = null;
        try {
          if (!isDynamicRecord(profile) || !(profile.avatarUrl === null || isString(profile.avatarUrl))) {
            return yield* failure("invalid_input");
          }
          avatarUrl = normalizeAvatarUrl(profile.avatarUrl);
        } catch {
          return yield* failure("invalid_input");
        }
        if (
          !username ||
          !isDynamicRecord(profile) ||
          !isString(profile.id) ||
          !validAccountId(profile.id) ||
          !name ||
          name.error ||
          !isString(input?.password) ||
          input.password.length < 12 ||
          input.password.length > 256
        ) {
          return yield* failure("invalid_input");
        }

        registerSecretValue(input.password);
        const createdAt = this.#readNow();
        const passwordSalt = randomBytes(16).toString("base64url");
        const passwordHash = (yield* derivePassword(input.password, passwordSalt)).toString("base64url");
        const account: StoredAccount = {
          id: profile.id,
          username,
          name: name.name,
          avatarUrl,
          passwordSalt,
          passwordHash,
          createdAt,
        };
        const next = { ...this.#file, accounts: [account] };
        yield* this.#persist(next);
        this.#file = next;
        return publicAccount(account);
      }),
    );
  });

  /** Sign in with the canonical username and password and create an opaque bearer session. */
  readonly signIn = Effect.fn("SelfHostedIdentityAuthority.signIn")(function* (
    this: SelfHostedIdentityAuthority,
    input: { readonly username: string; readonly password: string },
  ): Effect.fn.Return<SelfHostedSessionGrant, SelfHostedIdentityFailure> {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* this.#requireReady();
        const password = isString(input?.password) ? input.password : "";
        if (password.length > 256) return yield* failure("invalid_credentials");
        registerSecretValue(password);
        const account = this.#file.accounts[0];
        const salt = account?.passwordSalt ?? randomBytes(16).toString("base64url");
        const candidate = yield* derivePassword(password, salt);
        if (
          !account ||
          !isString(input?.username) ||
          normalizeUsername(input.username) !== account.username ||
          password.length < 12 ||
          !safePasswordEqual(candidate, account.passwordHash)
        ) {
          return yield* failure("invalid_credentials");
        }

        const now = this.#readNow();
        const pruned = this.#pruneExpired(now);
        if (pruned.sessions.length >= MAX_SESSIONS) return yield* failure("session_limit");
        const token = randomBytes(32).toString("base64url");
        registerSecretValue(token);
        const session: StoredSession = {
          id: randomUUID(),
          accountId: account.id,
          tokenHash: hashOpaqueToken(token),
          createdAt: now,
          expiresAt: now + SESSION_TTL_MS,
        };
        const next = { ...pruned, sessions: [...pruned.sessions, session] };
        yield* this.#persist(next);
        this.#file = next;
        return { account: publicAccount(account), token, expiresAt: session.expiresAt };
      }),
    );
  });

  /** Return the account for a valid session. Expired or unknown tokens return `null`. */
  readonly authenticateSession = Effect.fn("SelfHostedIdentityAuthority.authenticateSession")(function* (
    this: SelfHostedIdentityAuthority,
    token: string,
  ): Effect.fn.Return<SelfHostedAccount | null, SelfHostedIdentityFailure> {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* this.#requireReady();
        const now = this.#readNow();
        const pruned = this.#pruneExpired(now);
        if (pruned !== this.#file) {
          yield* this.#persist(pruned);
          this.#file = pruned;
        }
        const account = this.#findSessionAccount(token, pruned);
        return account ? publicAccount(account) : null;
      }),
    );
  });

  /** Revoke one session. Revoking an unknown or expired token is safe and returns `false`. */
  readonly revokeSession = Effect.fn("SelfHostedIdentityAuthority.revokeSession")(function* (
    this: SelfHostedIdentityAuthority,
    token: string,
  ): Effect.fn.Return<boolean, SelfHostedIdentityFailure> {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* this.#requireReady();
        const pruned = this.#pruneExpired(this.#readNow());
        const tokenHash = hashIfOpaqueToken(token);
        const matching = tokenHash
          ? (pruned.sessions.find((session) => safeTextEqual(session.tokenHash, tokenHash)) ?? null)
          : null;
        const next = matching
          ? { ...pruned, sessions: pruned.sessions.filter((session) => session !== matching) }
          : pruned;
        if (next !== this.#file) {
          yield* this.#persist(next);
          this.#file = next;
        }
        return matching !== null;
      }),
    );
  });

  /** Issue a short-lived ticket that can only be consumed by the named Team server. */
  readonly issueTeamTicket = Effect.fn("SelfHostedIdentityAuthority.issueTeamTicket")(function* (
    this: SelfHostedIdentityAuthority,
    input: { readonly sessionToken: string; readonly targetTeamServerId: string },
  ): Effect.fn.Return<SelfHostedTeamTicketGrant, SelfHostedIdentityFailure> {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* this.#requireReady();
        if (!isString(input?.targetTeamServerId) || !TEAM_SERVER_ID_PATTERN.test(input.targetTeamServerId)) {
          return yield* failure("invalid_input");
        }
        const now = this.#readNow();
        const pruned = this.#pruneExpired(now);
        const account = this.#findSessionAccount(isString(input?.sessionToken) ? input.sessionToken : "", pruned);
        if (!account) return yield* failure("invalid_session");
        if (pruned.teamTickets.length >= MAX_PENDING_TICKETS) return yield* failure("session_limit");

        const ticket = randomBytes(32).toString("base64url");
        registerSecretValue(ticket);
        const stored: StoredTeamTicket = {
          tokenHash: hashOpaqueToken(ticket),
          accountId: account.id,
          targetTeamServerId: input.targetTeamServerId,
          createdAt: now,
          expiresAt: now + TEAM_TICKET_TTL_MS,
        };
        const next = { ...pruned, teamTickets: [...pruned.teamTickets, stored] };
        yield* this.#persist(next);
        this.#file = next;
        return { ticket, expiresAt: stored.expiresAt };
      }),
    );
  });

  /** Consume a ticket once. A wrong server ID also consumes it, so it cannot be replayed elsewhere. */
  readonly consumeTeamTicket = Effect.fn("SelfHostedIdentityAuthority.consumeTeamTicket")(function* (
    this: SelfHostedIdentityAuthority,
    input: { readonly ticket: string; readonly targetTeamServerId: string },
  ): Effect.fn.Return<SelfHostedAccount | null, SelfHostedIdentityFailure> {
    return yield* this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        yield* this.#requireReady();
        const now = this.#readNow();
        const pruned = this.#pruneExpired(now);
        const ticket = isString(input?.ticket) ? input.ticket : "";
        const targetTeamServerId = isString(input?.targetTeamServerId) ? input.targetTeamServerId : "";
        const tokenHash = hashIfOpaqueToken(ticket);
        const matching = tokenHash
          ? pruned.teamTickets.find((ticket) => safeTextEqual(ticket.tokenHash, tokenHash))
          : null;
        const next = matching
          ? { ...pruned, teamTickets: pruned.teamTickets.filter((ticket) => ticket !== matching) }
          : pruned;
        if (next !== this.#file) {
          yield* this.#persist(next);
          this.#file = next;
        }
        if (!matching || matching.targetTeamServerId !== targetTeamServerId) return null;
        const account = next.accounts.find((candidate) => candidate.id === matching.accountId);
        return account ? publicAccount(account) : null;
      }),
    );
  });

  #requireReady(): Effect.Effect<void, SelfHostedIdentityFailure> {
    if (this.#unavailable) return Effect.fail(failure("storage_unavailable"));
    if (!this.#initialized) return Effect.fail(failure("not_initialized"));
    return Effect.void;
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) throw failure("internal_failure");
    return value;
  }

  #pruneExpired(now: number): IdentityFile {
    const sessions = this.#file.sessions.filter((session) => session.expiresAt > now);
    const teamTickets = this.#file.teamTickets.filter((ticket) => ticket.expiresAt > now);
    if (sessions.length === this.#file.sessions.length && teamTickets.length === this.#file.teamTickets.length) {
      return this.#file;
    }
    return { ...this.#file, sessions, teamTickets };
  }

  #findSessionAccount(token: string, file: IdentityFile): StoredAccount | null {
    const tokenHash = hashIfOpaqueToken(token);
    if (!tokenHash) return null;
    const session = file.sessions.find((candidate) => safeTextEqual(candidate.tokenHash, tokenHash));
    return session ? (file.accounts.find((account) => account.id === session.accountId) ?? null) : null;
  }

  #persist(file: IdentityFile): Effect.Effect<void, SelfHostedIdentityFailure> {
    if (this.#unavailable) return Effect.fail(failure("storage_unavailable"));
    return writePreferenceFile(this.#path, file, { createDirectory: true }).pipe(
      Effect.mapError((_error: PreferenceFileFailure) => failure("storage_unavailable")),
    );
  }
}

function hashIfOpaqueToken(token: string): string | null {
  if (!isString(token) || !OPAQUE_TOKEN_PATTERN.test(token)) return null;
  return hashOpaqueToken(token);
}
