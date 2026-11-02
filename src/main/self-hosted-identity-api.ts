import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  AccountServerDirectoryEntry,
  AccountServerRegistration,
  AccountServerVisibilityProof,
} from "@openbot/contracts/account-server-directory";
import { isTailscaleApiUrl } from "@openbot/contracts/invite-links";
import type { CentralAuthUser, TeamRole } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import {
  AccountServerDirectoryError,
  type SelfHostedAccountServerDirectory,
} from "./self-hosted-account-server-directory";
import type { SelfHostedAccount, SelfHostedIdentityAuthority } from "./self-hosted-identity-authority";
import { listenOnTailscale, type TailnetBinding, tailnetUrl, tailscaleAddresses } from "./tailscale-network";

export const SELF_HOSTED_IDENTITY_API_PORT = 43124;
const BODY_LIMIT_BYTES = 512 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;

type SelfHostedAccountUser = CentralAuthUser;
type TailnetListener = (server: Server, port: number) => Promise<TailnetBinding>;

interface IdentityRequestBody {
  email?: unknown;
  password?: unknown;
  ticket?: unknown;
  hostId?: unknown;
  fingerprint?: unknown;
  deviceId?: unknown;
  deviceName?: unknown;
  platform?: unknown;
  serverId?: unknown;
  name?: unknown;
  apiUrl?: unknown;
  publicKey?: unknown;
  logoKey?: unknown;
  origin?: unknown;
  membershipId?: unknown;
  role?: unknown;
  legacyImport?: unknown;
  rejoin?: unknown;
  visible?: unknown;
  nonce?: unknown;
  signature?: unknown;
  registration?: unknown;
}

export interface SelfHostedIdentityApiOptions {
  readonly authority: SelfHostedIdentityAuthority;
  readonly serverDirectory: SelfHostedAccountServerDirectory;
  readonly port?: number;
  readonly listen?: TailnetListener;
  /** When another trusted OpenBot process owns the shared port, discover it before failing startup. */
  readonly discoverExistingApiUrl?: (port: number, identityFingerprint: string | null) => Promise<string | null>;
  /** Host-local ownership is checked by the trusted process, never by the account client. */
  readonly isOwnerOfHost?: (accountId: string, hostId: string) => boolean | Promise<boolean>;
  /** The running local owner host can restore its own missing server-directory entry. */
  readonly getLocalOwnerServerRegistration?: (
    accountId: string,
  ) => AccountServerRegistration | null | Promise<AccountServerRegistration | null>;
  readonly onProfileChanged?: (user: SelfHostedAccountUser) => Promise<void>;
}

function localIdentityFingerprint(accountId: string | null): string | null {
  return accountId ? createHash("sha256").update(accountId).digest("base64url") : null;
}

export function isSelfHostedIdentityProbeResponse(value: unknown, expectedFingerprint: string | null): boolean {
  return (
    expectedFingerprint !== null &&
    isDynamicRecord(value) &&
    value.ok === true &&
    value.service === "openbot-self-hosted-identity" &&
    value.apiVersion === 1 &&
    value.identityFingerprint === expectedFingerprint
  );
}

async function discoverHealthyIdentityApi(port: number, expectedFingerprint: string | null): Promise<string | null> {
  if (!expectedFingerprint) return null;
  for (const binding of tailscaleAddresses()) {
    const apiUrl = tailnetUrl({ ...binding, port });
    try {
      const response = await fetch(new URL("/health/identity", apiUrl), { signal: AbortSignal.timeout(1_500) });
      if (!response.ok) continue;
      const body = await response.json();
      if (isSelfHostedIdentityProbeResponse(body, expectedFingerprint)) return apiUrl;
    } catch {
      // A port collision is only reusable when it is the expected live identity API.
    }
  }
  return null;
}

function asCentralAuthUser(account: SelfHostedAccount): SelfHostedAccountUser {
  return { id: account.id, email: account.email, name: account.name, avatarUrl: account.avatarUrl };
}

/** Team records store a short URL; the identity API serves validated avatar bytes over Tailscale. */
export function selfHostedTeamProfile(user: CentralAuthUser, identityApiUrl: string | null): CentralAuthUser {
  const avatarApi = identityApiUrl && isTailscaleApiUrl(identityApiUrl) ? identityApiUrl : null;
  const avatarUrl = avatarApi ? new URL("/v1/profile/avatar", avatarApi) : null;
  avatarUrl?.searchParams.set("account", user.id);
  return {
    ...user,
    avatarUrl: user.avatarUrl && avatarUrl ? avatarUrl.toString() : null,
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function image(response: ServerResponse, mimeType: string, bytes: Buffer): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": bytes.byteLength,
    "Content-Type": mimeType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(bytes);
}

function noContent(response: ServerResponse): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(204, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end();
}

async function readBody(request: IncomingMessage, limit = BODY_LIMIT_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > limit) throw new ApiError(413, "request_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

async function readJson(request: IncomingMessage): Promise<IdentityRequestBody> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ApiError(415, "unsupported_media_type");
  const body = await readBody(request, 32 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_request");
  }
  if (!isDynamicRecord(value)) throw new ApiError(400, "invalid_request");
  return {
    email: value.email,
    password: value.password,
    ticket: value.ticket,
    hostId: value.hostId,
    fingerprint: value.fingerprint,
    deviceId: value.deviceId,
    deviceName: value.deviceName,
    platform: value.platform,
    serverId: value.serverId,
    name: value.name,
    apiUrl: value.apiUrl,
    publicKey: value.publicKey,
    logoKey: value.logoKey,
    origin: value.origin,
    membershipId: value.membershipId,
    role: value.role,
    legacyImport: value.legacyImport,
    rejoin: value.rejoin,
    visible: value.visible,
    nonce: value.nonce,
    signature: value.signature,
    registration: value.registration,
  };
}

function stringField(
  body: IdentityRequestBody,
  name: keyof IdentityRequestBody,
  max = 256,
  allowEmpty = false,
): string {
  const value = body[name];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max)
    throw new ApiError(400, "invalid_request");
  return value;
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  return /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header)?.[1] ?? null;
}

function decodePlatform(value: unknown): "ios" | "android" | "unknown" {
  if (value === "ios" || value === "android" || value === "unknown") return value;
  throw new ApiError(400, "invalid_request");
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function failureStatus(code: string): 400 | 401 | 409 | 429 | 503 {
  switch (code) {
    case "invalid_session":
    case "invalid_ticket":
    case "invalid_credentials":
      return 401;
    case "invalid_input":
      return 400;
    case "session_limit":
      return 429;
    case "setup_completed":
    case "email_taken":
      return 409;
    default:
      return 503;
  }
}

export class SelfHostedIdentityApiServer {
  readonly #authority: SelfHostedIdentityAuthority;
  readonly #serverDirectory: SelfHostedAccountServerDirectory;
  readonly #port: number;
  readonly #listen: TailnetListener;
  readonly #discoverExistingApiUrl: (port: number, identityFingerprint: string | null) => Promise<string | null>;
  readonly #identityFingerprint: string | null;
  readonly #isOwnerOfHost: (accountId: string, hostId: string) => boolean | Promise<boolean>;
  readonly #getLocalOwnerServerRegistration:
    | ((accountId: string) => AccountServerRegistration | null | Promise<AccountServerRegistration | null>)
    | null;
  readonly #onProfileChanged: (user: SelfHostedAccountUser) => Promise<void>;
  readonly #requests = new Map<string, number[]>();
  readonly #authenticationRequests = new Map<string, number[]>();
  #server: Server | null = null;
  #apiUrl: string | null = null;
  #starting: Promise<string> | null = null;

  constructor(options: SelfHostedIdentityApiOptions) {
    this.#authority = options.authority;
    this.#serverDirectory = options.serverDirectory;
    this.#port = options.port ?? SELF_HOSTED_IDENTITY_API_PORT;
    this.#listen =
      options.listen ?? ((server, port) => listenOnTailscale(server, () => new Error("Tailscale bind failed."), port));
    this.#discoverExistingApiUrl = options.discoverExistingApiUrl ?? discoverHealthyIdentityApi;
    this.#identityFingerprint = localIdentityFingerprint(options.authority.getLocalAccount()?.id ?? null);
    this.#isOwnerOfHost = options.isOwnerOfHost ?? (() => false);
    this.#getLocalOwnerServerRegistration = options.getLocalOwnerServerRegistration ?? null;
    this.#onProfileChanged = options.onProfileChanged ?? (async () => undefined);
  }

  get apiUrl(): string | null {
    return this.#apiUrl;
  }

  async start(): Promise<string> {
    if (this.#apiUrl) return this.#apiUrl;
    if (this.#starting) return this.#starting;
    await this.#serverDirectory.initialize();
    const server = createServer((request, response) => void this.#handle(request, response));
    this.#server = server;
    const starting = this.#listen(server, this.#port)
      .then((binding) => {
        this.#apiUrl = tailnetUrl(binding);
        return this.#apiUrl;
      })
      .catch((error) => {
        if (this.#server === server) this.#server = null;
        if (server.listening) server.close();
        if (isDynamicRecord(error) && error.code === "EADDRINUSE") {
          return this.#discoverExistingApiUrl(this.#port, this.#identityFingerprint).then((existingApiUrl) => {
            if (existingApiUrl) {
              this.#apiUrl = existingApiUrl;
              return existingApiUrl;
            }
            throw error;
          });
        }
        throw error;
      })
      .finally(() => {
        if (this.#starting === starting) this.#starting = null;
      });
    this.#starting = starting;
    return starting;
  }

  async stop(): Promise<void> {
    await this.#starting?.catch(() => undefined);
    const server = this.#server;
    this.#server = null;
    this.#apiUrl = null;
    this.#requests.clear();
    this.#authenticationRequests.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  #rateLimit(request: IncomingMessage): void {
    const address = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const recent = (this.#requests.get(address) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) throw new ApiError(429, "rate_limited");
    recent.push(now);
    this.#requests.set(address, recent);
    if (this.#requests.size > 512) {
      for (const [key, entries] of this.#requests) {
        if (entries.every((time) => now - time >= RATE_WINDOW_MS)) this.#requests.delete(key);
      }
    }
  }

  #rateLimitAuthentication(request: IncomingMessage): void {
    const address = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const recent = (this.#authenticationRequests.get(address) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
    if (recent.length >= 5) throw new ApiError(429, "rate_limited");
    recent.push(now);
    this.#authenticationRequests.set(address, recent);
    if (this.#authenticationRequests.size > 512) {
      for (const [key, entries] of this.#authenticationRequests) {
        if (entries.every((time) => now - time >= RATE_WINDOW_MS)) this.#authenticationRequests.delete(key);
      }
    }
  }

  async #withOwnerStatus(
    accountId: string,
    servers: AccountServerDirectoryEntry[],
  ): Promise<AccountServerDirectoryEntry[]> {
    return Promise.all(
      servers.map(async (server) =>
        (await this.#isOwnerOfHost(accountId, server.hostId))
          ? { ...server, role: "owner" satisfies TeamRole, isOwner: true }
          : server,
      ),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      this.#rateLimit(request);

      if (method === "GET" && url.pathname === "/health/live") return json(response, 200, { ok: true });

      if (method === "GET" && url.pathname === "/health/identity") {
        return json(response, 200, {
          ok: true,
          service: "openbot-self-hosted-identity",
          apiVersion: 1,
          identityFingerprint: this.#identityFingerprint,
        });
      }

      if (method === "POST" && url.pathname === "/v1/auth/login") {
        this.#rateLimitAuthentication(request);
        const body = await readJson(request);
        const platform = body.platform === undefined ? undefined : decodePlatform(body.platform);
        const grant = await Effect.runPromise(
          this.#authority.signIn({
            username: stringField(body, "email", 254).toLowerCase(),
            password: stringField(body, "password", 256),
            ...(body.deviceId === undefined ? {} : { deviceId: stringField(body, "deviceId", 128) }),
            ...(body.deviceName === undefined ? {} : { deviceName: stringField(body, "deviceName", 80) }),
            ...(platform === undefined ? {} : { platform }),
          }),
        );
        return json(response, 200, {
          sessionToken: grant.token,
          user: asCentralAuthUser(grant.account),
          localOnly: true,
          expiresAt: grant.expiresAt,
        });
      }

      if (method === "POST" && url.pathname === "/v1/auth/register") {
        this.#rateLimitAuthentication(request);
        const body = await readJson(request);
        const platform = body.platform === undefined ? undefined : decodePlatform(body.platform);
        const grant = await Effect.runPromise(
          this.#authority.registerAccount({
            email: stringField(body, "email", 254),
            password: stringField(body, "password", 256),
            name: stringField(body, "name", 128),
            ...(body.deviceId === undefined ? {} : { deviceId: stringField(body, "deviceId", 128) }),
            ...(body.deviceName === undefined ? {} : { deviceName: stringField(body, "deviceName", 80) }),
            ...(platform === undefined ? {} : { platform }),
          }),
        );
        return json(response, 201, {
          sessionToken: grant.token,
          user: asCentralAuthUser(grant.account),
          localOnly: true,
          expiresAt: grant.expiresAt,
        });
      }

      if (method === "GET" && url.pathname === "/v1/profile/avatar") {
        const accountId = url.searchParams.get("account");
        if (url.searchParams.getAll("account").length > 1) return json(response, 400, { error: "invalid_request" });
        const account = accountId ? this.#authority.getAccount(accountId) : this.#authority.getLocalAccount();
        const avatarUrl = account?.avatarUrl ?? null;
        const match = avatarUrl
          ? /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(avatarUrl)
          : null;
        const mimeType = match?.[1];
        const base64 = match?.[2];
        if (!mimeType || !base64) return json(response, 404, { error: "not_found" });
        return image(response, mimeType, Buffer.from(base64, "base64"));
      }

      if (method === "POST" && url.pathname === "/v1/mobile-auth/redeem") {
        const body = await readJson(request);
        const host = {
          hostId: stringField(body, "hostId", 128),
          fingerprint: stringField(body, "fingerprint", 64),
        };
        const grant = await Effect.runPromise(
          this.#authority.redeemMobileConnectTicket({
            ticket: stringField(body, "ticket", 128),
            hostId: host.hostId,
            fingerprint: host.fingerprint,
            deviceId: stringField(body, "deviceId", 128),
            deviceName: stringField(body, "deviceName", 80),
            platform: decodePlatform(body.platform),
          }),
        );
        if (!grant) throw new ApiError(401, "invalid_ticket");
        return json(response, 200, {
          sessionToken: grant.token,
          user: asCentralAuthUser(grant.account),
          host,
          localOnly: true,
          expiresAt: grant.expiresAt,
        });
      }

      if (method === "GET" && url.pathname === "/v1/mobile-auth/session") {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        const account = await Effect.runPromise(this.#authority.authenticateSession(token));
        if (!account) throw new ApiError(401, "unauthorized");
        return json(response, 200, { user: asCentralAuthUser(account) });
      }

      if (method === "DELETE" && url.pathname === "/v1/mobile-auth/session") {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        await Effect.runPromise(this.#authority.revokeSession(token));
        return noContent(response);
      }

      if (method === "POST" && url.pathname === "/v1/team-auth/ticket") {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        const body = await readJson(request);
        const grant = await Effect.runPromise(
          this.#authority.issueTeamTicket({
            sessionToken: token,
            targetTeamServerId: stringField(body, "serverId", 128),
          }),
        );
        return json(response, 200, grant);
      }

      if (method === "POST" && url.pathname === "/v1/team-auth/redeem") {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        const authenticated = await Effect.runPromise(this.#authority.authenticateSession(token));
        if (!authenticated) throw new ApiError(401, "unauthorized");
        const body = await readJson(request);
        const account = await Effect.runPromise(
          this.#authority.consumeTeamTicket({
            ticket: stringField(body, "ticket", 128),
            targetTeamServerId: stringField(body, "serverId", 128),
          }),
        );
        // The session authenticates the host performing redemption. The ticket itself identifies
        // the joining account, which may be different from the host owner's account.
        return json(response, 200, { user: account ? asCentralAuthUser(account) : null });
      }

      if (method === "GET" && url.pathname === "/v1/me") {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        const account = await Effect.runPromise(this.#authority.authenticateSession(token));
        if (!account) throw new ApiError(401, "unauthorized");
        return json(response, 200, asCentralAuthUser(account));
      }

      if (method === "GET" && url.pathname === "/v1/me/servers") {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        const account = await Effect.runPromise(this.#authority.authenticateSession(token));
        if (!account) throw new ApiError(401, "unauthorized");
        let servers = await this.#serverDirectory.list(account.id);
        const localOwnerRegistration = await this.#getLocalOwnerServerRegistration?.(account.id);
        if (localOwnerRegistration && (await this.#isOwnerOfHost(account.id, localOwnerRegistration.hostId))) {
          // The host process provides this metadata only for the signed-in account that owns its
          // live Team host. Syncing refreshes a changed tailnet address without undoing hide/leave.
          await this.#serverDirectory.syncLocalOwnerRegistration(account.id, localOwnerRegistration);
          servers = await this.#serverDirectory.list(account.id);
        }
        return json(response, 200, { servers: await this.#withOwnerStatus(account.id, servers) });
      }

      if (url.pathname === "/v1/me/servers/legacy-import-exclusions" && method === "GET") {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        const account = await Effect.runPromise(this.#authority.authenticateSession(token));
        if (!account) throw new ApiError(401, "unauthorized");
        return json(response, 200, {
          excludedHostIds: await this.#serverDirectory.legacyImportExclusions(account.id),
        });
      }

      if (method === "PUT" && url.pathname === "/v1/me/servers") {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        const account = await Effect.runPromise(this.#authority.authenticateSession(token));
        if (!account) throw new ApiError(401, "unauthorized");
        const body = await readJson(request);
        const role = body.role;
        if (role !== "owner" && role !== "admin" && role !== "member") throw new ApiError(400, "invalid_request");
        if (body.legacyImport !== undefined && typeof body.legacyImport !== "boolean") {
          throw new ApiError(400, "invalid_request");
        }
        if (body.rejoin !== undefined && typeof body.rejoin !== "boolean") {
          throw new ApiError(400, "invalid_request");
        }
        if (body.origin !== undefined && body.origin !== "cloud") throw new ApiError(400, "invalid_request");
        const registration: AccountServerRegistration = {
          hostId: stringField(body, "hostId", 128),
          name: stringField(body, "name", 128),
          apiUrl: stringField(body, "apiUrl", 512),
          fingerprint: stringField(body, "fingerprint", 64),
          publicKey: stringField(body, "publicKey", 8192),
          logoKey: body.logoKey === null ? null : stringField(body, "logoKey", 256),
          membershipId: stringField(body, "membershipId", 128),
          // A server directory entry is not a permission grant. The Team host remains the
          // authority for real role checks; clients apply their locally paired role on this device.
          role: "member" satisfies TeamRole,
          ...(body.origin === "cloud" ? { origin: "cloud" as const } : {}),
          ...(body.legacyImport === true ? { legacyImport: true } : {}),
          ...(body.rejoin === true ? { rejoin: true } : {}),
        };
        return json(response, 200, {
          servers: await this.#withOwnerStatus(
            account.id,
            await this.#serverDirectory.register(account.id, registration),
          ),
        });
      }

      const visibilityMatch = /^\/v1\/me\/servers\/([^/]+)\/visibility$/u.exec(url.pathname);
      if (method === "PUT" && visibilityMatch) {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        const account = await Effect.runPromise(this.#authority.authenticateSession(token));
        if (!account) throw new ApiError(401, "unauthorized");
        let hostId: string;
        try {
          const encodedHostId = visibilityMatch[1];
          if (!encodedHostId) throw new Error("Missing server id.");
          hostId = decodeURIComponent(encodedHostId);
        } catch {
          throw new ApiError(400, "invalid_request");
        }
        const body = await readJson(request);
        if (typeof body.visible !== "boolean") throw new ApiError(400, "invalid_request");
        const proof: AccountServerVisibilityProof = {
          hostId,
          visible: body.visible,
          nonce: stringField(body, "nonce", 128),
          signature: stringField(body, "signature", 128),
        };
        await this.#serverDirectory.setServerVisibleWithOwnerProof(account.id, proof, body.registration);
        return noContent(response);
      }

      const accountServerMatch = /^\/v1\/me\/servers\/([^/]+)$/u.exec(url.pathname);
      if (method === "DELETE" && accountServerMatch) {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        const account = await Effect.runPromise(this.#authority.authenticateSession(token));
        if (!account) throw new ApiError(401, "unauthorized");
        let hostId: string;
        try {
          const encodedHostId = accountServerMatch[1];
          if (!encodedHostId) throw new Error("Missing server id.");
          hostId = decodeURIComponent(encodedHostId);
        } catch {
          throw new ApiError(400, "invalid_request");
        }
        await this.#serverDirectory.removeMembership(account.id, hostId);
        return noContent(response);
      }

      if (method === "PUT" && url.pathname === "/v1/me/credentials") {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        const body = await readJson(request);
        const account = await Effect.runPromise(
          this.#authority.configureSessionLoginCredentials({
            sessionToken: token,
            email: stringField(body, "email", 254),
            password: stringField(body, "password", 256, true),
          }),
        );
        return json(response, 200, asCentralAuthUser(account));
      }

      if (
        (method === "PATCH" && url.pathname === "/v1/me/profile") ||
        (["PUT", "DELETE"].includes(method) && url.pathname === "/v1/me/avatar")
      ) {
        const token = bearer(request);
        if (!token) throw new ApiError(401, "unauthorized");
        let change: { name?: string; avatarUrl?: string | null };
        if (url.pathname.endsWith("/profile")) {
          const body = await readJson(request);
          change = { name: stringField(body, "name", 128) };
        } else if (method === "DELETE") {
          change = { avatarUrl: null };
        } else {
          const mime = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
          if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp")
            throw new ApiError(415, "unsupported_media_type");
          const bytes = await readBody(request, 256 * 1024);
          if (bytes.length === 0) throw new ApiError(400, "invalid_request");
          change = { avatarUrl: `data:${mime};base64,${bytes.toString("base64")}` };
        }
        const account = await Effect.runPromise(this.#authority.updateProfile({ sessionToken: token, ...change }));
        const user = asCentralAuthUser(account);
        await this.#onProfileChanged(user);
        return json(response, 200, user);
      }

      return json(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ApiError) return json(response, error.status, { error: error.code });
      if (error instanceof AccountServerDirectoryError) return json(response, error.status, { error: error.code });
      const code = isDynamicRecord(error) && isString(error.code) ? error.code : null;
      if (code)
        return json(response, failureStatus(code), { error: failureStatus(code) === 503 ? "unavailable" : code });
      // Never serialize the request body, token, URL query, or an exception message to logs or clients.
      return json(response, 503, { error: "unavailable" });
    }
  }
}
