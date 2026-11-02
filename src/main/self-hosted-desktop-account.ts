import { isIP } from "node:net";
import type {
  AccountServerDirectoryEntry,
  AccountServerRegistration,
  AccountServerVisibilityProof,
} from "@openbot/contracts/account-server-directory";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isTailscaleApiUrl } from "@openbot/contracts/invite-links";
import type { AvatarImageInput, CentralAuthState, CentralAuthUser } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { normalizeEmailAddress, validateProfileName } from "@openbot/contracts/validation";
import { Effect, Result } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

const IDENTITY_API_PORT = "43124";
const REQUEST_TIMEOUT_MS = 8_000;

type Mode = "local" | "signed_out" | "account";

interface StoredAccountState {
  readonly version: 1;
  readonly mode: Mode;
  readonly apiUrl: string | null;
  readonly encryptedToken: string | null;
  readonly user: CentralAuthUser | null;
}

export interface DesktopSecretCipher {
  canPersist(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

function validUser(value: unknown): CentralAuthUser | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    value.id.length < 1 ||
    value.id.length > 128 ||
    !isString(value.email) ||
    value.email.length > 254 ||
    !(value.name === null || isString(value.name)) ||
    !(value.avatarUrl === null || isString(value.avatarUrl))
  ) {
    return null;
  }
  return { id: value.id, email: value.email, name: value.name, avatarUrl: value.avatarUrl };
}

function decodeStoredState(value: unknown): StoredAccountState {
  if (
    !isDynamicRecord(value) ||
    value.version !== 1 ||
    (value.mode !== "local" && value.mode !== "signed_out" && value.mode !== "account") ||
    !(value.apiUrl === null || isString(value.apiUrl)) ||
    !(value.encryptedToken === null || isString(value.encryptedToken)) ||
    !(value.user === null || validUser(value.user))
  ) {
    throw new Error("The desktop account session file is invalid.");
  }
  if (value.mode === "account" && (!value.apiUrl || !value.encryptedToken || !validUser(value.user))) {
    throw new Error("The desktop account session file is incomplete.");
  }
  return {
    version: 1,
    mode: value.mode,
    apiUrl: value.apiUrl,
    encryptedToken: value.encryptedToken,
    user: validUser(value.user),
  };
}

function privateIdentityHost(host: string): boolean {
  const address =
    host
      .replace(/^\[|\]$/gu, "")
      .split("%", 1)[0]
      ?.toLowerCase() ?? "";
  if (address === "localhost" || address.endsWith(".ts.net")) return true;
  const v4 = address.split(".").map(Number);
  if (v4.length === 4 && v4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const first = v4[0] ?? -1;
    const second = v4[1] ?? -1;
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      first === 127 ||
      (first === 169 && second === 254)
    );
  }
  return address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:");
}

export function normalizeDesktopIdentityApiUrl(value: string): string {
  if (!value.trim() || value.length > 2048) throw new Error("サーバーアドレスを確認してください。");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("サーバーアドレスを確認してください。");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("サーバーアドレスにはホスト名とポートだけを入力してください。");
  }
  if (url.protocol === "http:") {
    if (!url.port) url.port = IDENTITY_API_PORT;
    if (!privateIdentityHost(url.hostname) && !isTailscaleApiUrl(url.origin)) {
      throw new Error("外部ネットワークではHTTPSのサーバーアドレスを使用してください。");
    }
  }
  if (url.protocol === "https:" && isIP(url.hostname.replace(/^\[|\]$/gu, ""))) {
    // HTTPS to an IP is permitted for private self-hosted deployments, where local certificate
    // management is the administrator's responsibility.
    if (!privateIdentityHost(url.hostname)) throw new Error("公開IPアドレスにはHTTPSドメインを使用してください。");
  }
  return url.origin;
}

function decodeApiUser(value: unknown): CentralAuthUser {
  if (!isDynamicRecord(value)) throw new Error("認証サーバーから不正なアカウント情報が返されました。");
  const user = validUser(value.user ?? value);
  if (!user) throw new Error("認証サーバーから不正なアカウント情報が返されました。");
  return user;
}

function decodeSession(value: unknown): { token: string; user: CentralAuthUser } {
  if (!isDynamicRecord(value) || !isString(value.sessionToken) || !/^[A-Za-z0-9_-]{43}$/u.test(value.sessionToken)) {
    throw new Error("認証サーバーから不正なセッションが返されました。");
  }
  return { token: value.sessionToken, user: decodeApiUser(value) };
}

function decodeAccountServers(value: unknown): AccountServerDirectoryEntry[] {
  if (!isDynamicRecord(value) || !Array.isArray(value.servers) || value.servers.length > 10_000) {
    throw new Error("アカウントのサーバー一覧が不正です。");
  }
  return value.servers.map((entry): AccountServerDirectoryEntry => {
    if (
      !isDynamicRecord(entry) ||
      !isString(entry.hostId) ||
      !isString(entry.name) ||
      !isString(entry.apiUrl) ||
      !isTailscaleApiUrl(entry.apiUrl) ||
      !isString(entry.fingerprint) ||
      !isString(entry.publicKey) ||
      !(entry.logoKey === null || isString(entry.logoKey)) ||
      !(entry.origin === undefined || entry.origin === "cloud") ||
      !isString(entry.membershipId) ||
      (entry.role !== "owner" && entry.role !== "admin" && entry.role !== "member") ||
      typeof entry.isOwner !== "boolean"
    ) {
      throw new Error("アカウントのサーバー一覧が不正です。");
    }
    return {
      hostId: entry.hostId,
      name: entry.name,
      apiUrl: entry.apiUrl,
      fingerprint: entry.fingerprint,
      publicKey: entry.publicKey,
      logoKey: entry.logoKey,
      ...(entry.origin === undefined ? {} : { origin: entry.origin }),
      membershipId: entry.membershipId,
      role: entry.role,
      isOwner: entry.isOwner,
    };
  });
}

type IdentityRequestBody =
  | { readonly email: string; readonly password: string; readonly name?: string }
  | { readonly name: string }
  | { readonly serverId: string }
  | { readonly ticket: string; readonly serverId: string }
  | AccountServerVisibilityProof
  | AccountServerRegistration;

function accountError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error("セルフホストアカウントサーバーに接続できません。");
}

/**
 * Desktop sign-in for the fork's local identity service. Only the bearer token is encrypted at
 * rest; the password is never persisted. Legacy device-profile data stays on disk for compatibility,
 * but it is never an authentication fallback. Logout never removes conversations or provider data.
 */
export class SelfHostedDesktopAccountManager {
  readonly #path: string;
  readonly #cipher: DesktopSecretCipher;
  #record: StoredAccountState = { version: 1, mode: "signed_out", apiUrl: null, encryptedToken: null, user: null };
  #token: string | null = null;
  #loadFailure: PreferenceFileFailure | null = null;
  #sessionIssue: CentralAuthState | null = null;

  constructor(input: { path: string; cipher: DesktopSecretCipher }) {
    this.#path = input.path;
    this.#cipher = input.cipher;
  }

  async initialize(): Promise<void> {
    const loaded = await Effect.runPromise(Effect.result(readPreferenceFile(this.#path, decodeStoredState)));
    if (Result.isSuccess(loaded)) {
      this.#record = loaded.success;
      // Older builds silently treated the machine-local profile as a signed-in account. Keep its
      // files intact, but migrate that mode to signed-out so the user must authenticate explicitly.
      if (this.#record.mode === "local") {
        this.#record = {
          version: 1,
          mode: "signed_out",
          apiUrl: this.#record.apiUrl,
          encryptedToken: null,
          user: null,
        };
        try {
          await Effect.runPromise(this.#persist());
        } catch {
          // The in-memory state still requires sign-in; a future login can retry the save.
        }
        return;
      }
      if (this.#record.mode === "account" && this.#record.encryptedToken) {
        try {
          this.#token = this.#cipher.decrypt(Buffer.from(this.#record.encryptedToken, "base64"));
        } catch {
          this.#sessionIssue = {
            status: "error",
            issue: {
              code: "auth_api_error",
              message: "この端末で保存したログイン情報を復号できません。もう一度サインインしてください。",
            },
          };
        }
      }
      return;
    }
    if (isMissingFileError(loaded.failure.cause)) return;
    this.#loadFailure = loaded.failure;
  }

  getState(): CentralAuthState {
    if (this.#sessionIssue) return this.#sessionIssue;
    if (this.#record.mode === "local") return { status: "signed_out" };
    if (this.#record.mode === "signed_out") return { status: "signed_out" };
    return this.#record.user ? { status: "signed_in", user: this.#record.user } : { status: "signed_out" };
  }

  getServerAddress(): string {
    return this.#record.apiUrl ?? "";
  }

  get isUsingLocalProfile(): boolean {
    return false;
  }

  get isSignedIn(): boolean {
    return this.getState().status === "signed_in";
  }

  readonly saveServerAddress = Effect.fn("SelfHostedDesktopAccountManager.saveServerAddress")(function* (
    this: SelfHostedDesktopAccountManager,
    address: string,
  ): Effect.fn.Return<string, Error> {
    const apiUrl = yield* Effect.try({ try: () => normalizeDesktopIdentityApiUrl(address), catch: accountError });
    this.#record = { ...this.#record, apiUrl };
    yield* this.#persist();
    return apiUrl;
  });

  readonly signIn = Effect.fn("SelfHostedDesktopAccountManager.signIn")(function* (
    this: SelfHostedDesktopAccountManager,
    input: { serverAddress: string; email: string; password: string },
  ): Effect.fn.Return<CentralAuthState, Error> {
    const apiUrl = yield* Effect.try({
      try: () => normalizeDesktopIdentityApiUrl(input.serverAddress),
      catch: accountError,
    });
    if (!this.#cipher.canPersist())
      return yield* Effect.fail(new Error("この端末では安全なログイン保存を利用できません。"));
    const email = normalizeEmailAddress(input.email);
    if (!email || email.length > INPUT_LIMITS.email)
      return yield* Effect.fail(new Error("メールアドレスを確認してください。"));
    if (!input.password || input.password.length > 256)
      return yield* Effect.fail(new Error("パスワードを入力してください。"));
    this.#record = { version: 1, mode: "signed_out", apiUrl, encryptedToken: null, user: null };
    this.#token = null;
    this.#sessionIssue = null;
    yield* this.#persist();
    const result = yield* this.#postSession(apiUrl, "/v1/auth/login", { email, password: input.password });
    yield* this.#storeSession(apiUrl, result);
    return { status: "signed_in", user: result.user };
  });

  readonly register = Effect.fn("SelfHostedDesktopAccountManager.register")(function* (
    this: SelfHostedDesktopAccountManager,
    input: { serverAddress: string; email: string; password: string; name: string },
  ): Effect.fn.Return<CentralAuthState, Error> {
    const apiUrl = yield* Effect.try({
      try: () => normalizeDesktopIdentityApiUrl(input.serverAddress),
      catch: accountError,
    });
    if (!this.#cipher.canPersist())
      return yield* Effect.fail(new Error("この端末では安全なログイン保存を利用できません。"));
    const email = normalizeEmailAddress(input.email);
    const name = validateProfileName(input.name);
    if (!email || email.length > INPUT_LIMITS.email)
      return yield* Effect.fail(new Error("メールアドレスを確認してください。"));
    if (input.password.length < 12 || input.password.length > 256) {
      return yield* Effect.fail(new Error("パスワードは12文字以上で入力してください。"));
    }
    if (name.error) return yield* Effect.fail(new Error("アカウント名を確認してください。"));
    this.#record = { version: 1, mode: "signed_out", apiUrl, encryptedToken: null, user: null };
    this.#token = null;
    this.#sessionIssue = null;
    yield* this.#persist();
    const result = yield* this.#postSession(apiUrl, "/v1/auth/register", {
      email,
      password: input.password,
      name: name.name,
    });
    yield* this.#storeSession(apiUrl, result);
    return { status: "signed_in", user: result.user };
  });

  readonly retry = Effect.fn("SelfHostedDesktopAccountManager.retry")(function* (
    this: SelfHostedDesktopAccountManager,
  ): Effect.fn.Return<CentralAuthState, Error> {
    if (this.#record.mode === "local") return { status: "signed_out" };
    if (!this.#record.apiUrl) return { status: "signed_out" };
    if (this.#record.mode === "account" && this.#token) {
      const user = yield* this.#requestJson(this.#record.apiUrl, "/v1/me", { token: this.#token });
      const validated = decodeApiUser(user);
      if (this.#record.user?.id !== validated.id)
        return yield* Effect.fail(new Error("ログイン中のアカウントが一致しません。"));
      this.#record = { ...this.#record, user: validated };
      this.#sessionIssue = null;
      yield* this.#persist();
      return { status: "signed_in", user: validated };
    }
    const health = yield* this.#requestJson(this.#record.apiUrl, "/health/live");
    if (!isDynamicRecord(health) || health.ok !== true)
      return yield* Effect.fail(new Error("認証サーバーが応答しません。"));
    this.#sessionIssue = null;
    return { status: "signed_out" };
  });

  readonly logout = Effect.fn("SelfHostedDesktopAccountManager.logout")(function* (
    this: SelfHostedDesktopAccountManager,
  ): Effect.fn.Return<CentralAuthState, Error> {
    if (this.#record.mode === "account" && this.#record.apiUrl && this.#token) {
      yield* this.#requestJson(this.#record.apiUrl, "/v1/mobile-auth/session", {
        token: this.#token,
        method: "DELETE",
      }).pipe(Effect.catch(() => Effect.succeed(null)));
    }
    this.#record = { version: 1, mode: "signed_out", apiUrl: this.#record.apiUrl, encryptedToken: null, user: null };
    this.#token = null;
    this.#sessionIssue = null;
    yield* this.#persist();
    return { status: "signed_out" };
  });

  /** Kept for IPC compatibility with older renderers; local profiles are no longer an auth mode. */
  readonly useLocalProfile = Effect.fn("SelfHostedDesktopAccountManager.useLocalProfile")(function* (
    this: SelfHostedDesktopAccountManager,
  ): Effect.fn.Return<CentralAuthState, Error> {
    return yield* this.logout();
  });

  readonly updateName = Effect.fn("SelfHostedDesktopAccountManager.updateName")(function* (
    this: SelfHostedDesktopAccountManager,
    name: string,
  ): Effect.fn.Return<CentralAuthState, Error> {
    const validation = validateProfileName(name);
    if (validation.error) return yield* Effect.fail(new Error("アカウント名を確認してください。"));
    if (this.#record.mode !== "account" || !this.#record.apiUrl || !this.#token) {
      return yield* Effect.fail(new Error("サインインしてから変更してください。"));
    }
    const response = yield* this.#requestJson(this.#record.apiUrl, "/v1/me/profile", {
      token: this.#token,
      method: "PATCH",
      body: { name: validation.name },
    });
    const user = decodeApiUser(response);
    this.#record = { ...this.#record, user };
    yield* this.#persist();
    return { status: "signed_in", user };
  });

  readonly updateAvatar = Effect.fn("SelfHostedDesktopAccountManager.updateAvatar")(function* (
    this: SelfHostedDesktopAccountManager,
    image: AvatarImageInput | null,
  ): Effect.fn.Return<CentralAuthState, Error> {
    if (this.#record.mode !== "account" || !this.#record.apiUrl || !this.#token) {
      return yield* Effect.fail(new Error("サインインしてから変更してください。"));
    }
    const response = yield* this.#requestJson(this.#record.apiUrl, "/v1/me/avatar", {
      token: this.#token,
      method: image ? "PUT" : "DELETE",
      ...(image ? { bytes: image.bytes, mimeType: image.mimeType } : {}),
    });
    const user = decodeApiUser(response);
    this.#record = { ...this.#record, user };
    yield* this.#persist();
    return { status: "signed_in", user };
  });

  readonly createTeamAuthTicket = (serverId: string): Effect.Effect<string, Error> =>
    Effect.gen({ self: this }, function* () {
      if (this.#record.mode !== "account" || !this.#record.apiUrl || !this.#token) {
        return yield* Effect.fail(new Error("アカウントにサインインしてください。"));
      }
      const value = yield* this.#requestJson(this.#record.apiUrl, "/v1/team-auth/ticket", {
        token: this.#token,
        method: "POST",
        body: { serverId },
      });
      if (!isDynamicRecord(value) || !isString(value.ticket) || !/^[A-Za-z0-9_-]{43}$/u.test(value.ticket)) {
        return yield* Effect.fail(new Error("アカウントサーバーから不正な接続チケットが返されました。"));
      }
      return value.ticket;
    });

  readonly redeemTeamAuthTicket = (ticket: string, serverId: string): Effect.Effect<CentralAuthUser | null, Error> =>
    Effect.gen({ self: this }, function* () {
      if (this.#record.mode !== "account" || !this.#record.apiUrl || !this.#token || !this.#record.user) {
        return yield* Effect.fail(new Error("アカウントにサインインしてください。"));
      }
      const value = yield* this.#requestJson(this.#record.apiUrl, "/v1/team-auth/redeem", {
        token: this.#token,
        method: "POST",
        body: { ticket, serverId },
      });
      if (!isDynamicRecord(value) || !("user" in value)) {
        return yield* Effect.fail(new Error("アカウントサーバーから不正な接続確認結果が返されました。"));
      }
      const user = value.user === null ? null : validUser(value.user);
      if (value.user !== null && !user) {
        return yield* Effect.fail(new Error("アカウントサーバーから不正な接続確認結果が返されました。"));
      }
      return user;
    });

  readonly listAccountServers = (): Effect.Effect<AccountServerDirectoryEntry[], Error> =>
    Effect.gen({ self: this }, function* () {
      if (this.#record.mode !== "account" || !this.#record.apiUrl || !this.#token) {
        return yield* Effect.fail(new Error("アカウントにサインインしてください。"));
      }
      const value = yield* this.#requestJson(this.#record.apiUrl, "/v1/me/servers", { token: this.#token });
      return yield* Effect.try({ try: () => decodeAccountServers(value), catch: accountError });
    });

  readonly getLegacyAccountServerImportExclusions = (): Effect.Effect<string[], Error> =>
    Effect.gen({ self: this }, function* () {
      if (this.#record.mode !== "account" || !this.#record.apiUrl || !this.#token) {
        return yield* Effect.fail(new Error("アカウントにサインインしてください。"));
      }
      const value = yield* this.#requestJson(this.#record.apiUrl, "/v1/me/servers/legacy-import-exclusions", {
        token: this.#token,
      });
      if (
        !isDynamicRecord(value) ||
        !Array.isArray(value.excludedHostIds) ||
        value.excludedHostIds.length > 10_000 ||
        !value.excludedHostIds.every((hostId) => typeof hostId === "string")
      ) {
        return yield* Effect.fail(new Error("アカウントのサーバー除外一覧が不正です。"));
      }
      return [...new Set(value.excludedHostIds.filter((hostId): hostId is string => typeof hostId === "string"))];
    });

  readonly registerAccountServer = (registration: AccountServerRegistration): Effect.Effect<void, Error> =>
    Effect.gen({ self: this }, function* () {
      if (this.#record.mode !== "account" || !this.#record.apiUrl || !this.#token) {
        return yield* Effect.fail(new Error("アカウントにサインインしてください。"));
      }
      yield* this.#requestJson(this.#record.apiUrl, "/v1/me/servers", {
        token: this.#token,
        method: "PUT",
        body: registration,
      });
    });

  readonly removeAccountServer = (hostId: string): Effect.Effect<void, Error> =>
    Effect.gen({ self: this }, function* () {
      if (this.#record.mode !== "account" || !this.#record.apiUrl || !this.#token) {
        return yield* Effect.fail(new Error("アカウントにサインインしてください。"));
      }
      yield* this.#requestJson(this.#record.apiUrl, `/v1/me/servers/${encodeURIComponent(hostId)}`, {
        token: this.#token,
        method: "DELETE",
      });
    });

  readonly setAccountServerVisibility = (
    proof: AccountServerVisibilityProof,
    registration?: AccountServerRegistration,
  ): Effect.Effect<void, Error> =>
    Effect.gen({ self: this }, function* () {
      if (this.#record.mode !== "account" || !this.#record.apiUrl || !this.#token) {
        return yield* Effect.fail(new Error("アカウントにサインインしてください。"));
      }
      yield* this.#requestJson(this.#record.apiUrl, `/v1/me/servers/${encodeURIComponent(proof.hostId)}/visibility`, {
        token: this.#token,
        method: "PUT",
        body: { ...proof, ...(registration ? { registration } : {}) },
      });
    });

  get signedInAccount(): CentralAuthUser | null {
    return this.#record.mode === "account" ? this.#record.user : null;
  }

  #postSession(
    apiUrl: string,
    path: string,
    body: { readonly email: string; readonly password: string; readonly name?: string },
  ): Effect.Effect<{ token: string; user: CentralAuthUser }, Error> {
    return Effect.gen({ self: this }, function* () {
      const value = yield* this.#requestJson(apiUrl, path, { method: "POST", body });
      return yield* Effect.try({ try: () => decodeSession(value), catch: accountError });
    });
  }

  #storeSession(apiUrl: string, session: { token: string; user: CentralAuthUser }): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      if (!this.#cipher.canPersist())
        return yield* Effect.fail(new Error("この端末では安全なログイン保存を利用できません。"));
      let encryptedToken: string;
      try {
        encryptedToken = this.#cipher.encrypt(session.token).toString("base64");
      } catch (error) {
        return yield* Effect.fail(accountError(error));
      }
      this.#token = session.token;
      this.#record = { version: 1, mode: "account", apiUrl, encryptedToken, user: session.user };
      this.#sessionIssue = null;
      yield* this.#persist();
    });
  }

  #requestJson(
    apiUrl: string,
    path: string,
    options: {
      token?: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: IdentityRequestBody;
      bytes?: Uint8Array;
      mimeType?: string;
    } = {},
  ): Effect.Effect<unknown, Error> {
    return Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const headers: Record<string, string> = {};
          if (options.token) headers.Authorization = `Bearer ${options.token}`;
          let body: BodyInit | undefined;
          if (options.body) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(options.body);
          } else if (options.bytes) {
            headers["Content-Type"] = options.mimeType ?? "application/octet-stream";
            body = Buffer.from(options.bytes);
          }
          const response = await fetch(new URL(path, apiUrl), {
            method: options.method ?? "GET",
            headers,
            body,
            signal: controller.signal,
          });
          const text = response.status === 204 ? "" : await response.text();
          if (text.length > 512 * 1024) throw new Error("アカウントサーバーの応答が大きすぎます。");
          let value: unknown = null;
          if (text) {
            try {
              value = JSON.parse(text);
            } catch {
              throw new Error("アカウントサーバーからJSON以外の応答が返されました。");
            }
          }
          if (!response.ok) {
            const code = isDynamicRecord(value) && isString(value.error) ? value.error : "unavailable";
            const message =
              response.status === 401
                ? "メールアドレスまたはパスワード、ログイン状態を確認してください。"
                : response.status === 409 && code === "email_taken"
                  ? "このメールアドレスは既に登録されています。"
                  : response.status === 429
                    ? "試行回数が多すぎます。少し待ってから再試行してください。"
                    : response.status === 404
                      ? "このサーバーはセルフホストアカウントログインに対応していません。"
                      : "セルフホストアカウントサーバーに接続できません。";
            throw new Error(message);
          }
          return value;
        } finally {
          clearTimeout(timeout);
        }
      },
      catch: accountError,
    });
  }

  #persist(): Effect.Effect<void, PreferenceFileFailure> {
    if (this.#loadFailure) return Effect.fail(this.#loadFailure);
    return writePreferenceFile(this.#path, this.#record, { createDirectory: true });
  }
}
