import type {
  AccountServerDirectoryEntry,
  AccountServerRegistration,
} from "@openbot/contracts/account-server-directory";
import { type AvatarMimeType, isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { AVATAR_IMAGE_LIMITS } from "@openbot/contracts/input-limits";
import { isTailscaleApiUrl } from "@openbot/contracts/invite-links";
import type { CentralAuthUser } from "@openbot/contracts/ipc";
import {
  isMobileConnectDevelopmentHost,
  isMobileConnectHostBinding,
  type MobileConnectHostBinding,
  parseMobileConnectUrl,
  validateMobileConnectHostBinding,
} from "@openbot/contracts/mobile-connect";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { validateProfileName } from "@openbot/contracts/validation";
import { remoteHostFingerprint } from "@openbot/team-client/remote-directory";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";
import { type LocalTailnetServer, pairTailnetInvite } from "@/features/workspace/model/local-tailnet";
import { saveLocalTailnetServer } from "@/features/workspace/model/local-tailnet-store";
import { mobileAppVersion } from "@/shared/lib/mobile-features";
import { isAndroid, isIOS } from "@/shared/lib/platform";
import { currentText } from "@/shared/lib/text";
// Relative: the Node test project resolves no `@/` path that the test does not mock.
import { fetch } from "../../support/model/logged-fetch";
import { serverOrderKey } from "../../workspace/model/server-order";
import { normalizeMobileConnectLink } from "../model/mobile-connect-url";

const MOBILE_SESSION_KEY = "openbot.mobile.session.v1";
const LOCAL_IDENTITY_SESSION_KEY = "openbot.local-identity.session.v1";
const LOCAL_IDENTITY_API_URL_KEY = "openbot.local-identity.api-url.v1";
const MOBILE_REVOCATIONS_KEY = "openbot.mobile.pending-revocations.v1";
const ACCOUNT_SERVER_CHANGES_KEY = "openbot.account-server.pending-changes.v1";
const MOBILE_DEVICE_ID_KEY = "openbot.mobile.device-id.v1";
const MOBILE_AUTH_REQUEST_TIMEOUT_MS = 10_000;
const LOCAL_IDENTITY_DEFAULT_PORT = "43124";

let mobileSessionStorageTail = Promise.resolve();
let mobileProfileTail = Promise.resolve();
let mobileConnectInFlight = false;
const accountServerFlushTails = new Map<string, Promise<void>>();

type PendingAccountServerChange =
  | { id: string; kind: "register"; server: AccountServerRegistration; legacyImport?: true; rejoin?: true }
  | { id: string; kind: "remove"; hostId: string };

function decodePendingAccountServerChange(value: unknown): PendingAccountServerChange | null {
  if (!isDynamicRecord(value) || !isString(value.id)) return null;
  if (value.kind === "remove" && isString(value.hostId)) {
    return { id: value.id, kind: "remove", hostId: value.hostId };
  }
  if (value.kind !== "register" || !isDynamicRecord(value.server)) return null;
  try {
    const server = decodeAccountServer({ ...value.server, isOwner: false });
    return {
      id: value.id,
      kind: "register",
      ...(value.legacyImport === true ? { legacyImport: true as const } : {}),
      ...(value.rejoin === true ? { rejoin: true as const } : {}),
      server: {
        hostId: server.hostId,
        name: server.name,
        apiUrl: server.apiUrl,
        fingerprint: server.fingerprint,
        publicKey: server.publicKey,
        logoKey: server.logoKey,
        ...(server.origin === "cloud" ? { origin: "cloud" as const } : {}),
        membershipId: server.membershipId,
        role: server.role,
      },
    };
  } catch {
    return null;
  }
}

export class MobileSessionExpiredError extends Error {
  constructor() {
    super(currentText().t("mobile.auth.error.sessionEnded"));
  }
}

export interface MobileSession {
  apiUrl: string;
  sessionToken: string;
  user: CentralAuthUser;
  host?: MobileConnectHostBinding;
  /** Uses an on-device profile and direct Tailscale pairing instead of an account service. */
  localOnly?: boolean;
}

function decodeAccountServer(value: unknown): AccountServerDirectoryEntry {
  if (
    !isDynamicRecord(value) ||
    !isString(value.hostId) ||
    !isString(value.name) ||
    !isString(value.apiUrl) ||
    !isTailscaleApiUrl(value.apiUrl) ||
    !isString(value.fingerprint) ||
    !isString(value.publicKey) ||
    remoteHostFingerprint(value.publicKey) !== value.fingerprint ||
    !(value.logoKey === null || isString(value.logoKey)) ||
    !(value.origin === undefined || value.origin === "cloud") ||
    !isString(value.membershipId) ||
    (value.role !== "owner" && value.role !== "admin" && value.role !== "member") ||
    typeof value.isOwner !== "boolean"
  ) {
    throw new Error("The account service returned an invalid server list.");
  }
  return {
    hostId: value.hostId,
    name: value.name,
    apiUrl: value.apiUrl,
    fingerprint: value.fingerprint,
    publicKey: value.publicKey,
    logoKey: value.logoKey,
    ...(value.origin === undefined ? {} : { origin: value.origin }),
    membershipId: value.membershipId,
    role: value.role,
    isOwner: value.isOwner,
  };
}

function decodeAccountServerList(value: unknown): AccountServerDirectoryEntry[] {
  if (!isDynamicRecord(value) || !Array.isArray(value.servers)) {
    throw new Error("The account service returned an invalid server list.");
  }
  return value.servers.map(decodeAccountServer);
}

function accountServerRegistrationForHost(host: LocalTailnetServer): AccountServerRegistration {
  return {
    hostId: host.hostId,
    name: host.name,
    apiUrl: host.apiUrl,
    fingerprint: host.fingerprint,
    publicKey: host.publicKey,
    logoKey: host.logoKey,
    ...(host.origin === "cloud" ? { origin: "cloud" as const } : {}),
    membershipId: host.membershipId,
    role: host.role,
  };
}

async function accountServerRequest(
  session: MobileSession,
  method: "GET" | "PUT" | "DELETE",
  host?: AccountServerRegistration,
  hostId?: string,
  flushPending = true,
  legacyImport = false,
  rejoin = false,
): Promise<AccountServerDirectoryEntry[]> {
  if (!session.localOnly || !session.sessionToken) {
    throw new Error("Sign in to the self-hosted account server to sync the server list.");
  }
  if (flushPending && method === "GET") await flushPendingAccountServerChanges(session).catch(() => undefined);
  const path = host
    ? "/v1/me/servers"
    : method === "DELETE"
      ? `/v1/me/servers/${encodeURIComponent(hostId ?? "")}`
      : "/v1/me/servers";
  const { response, body } = await withMobileAuthRequestTimeout(async (signal) => {
    const request = await fetch(new URL(path, session.apiUrl).toString(), {
      method,
      headers: {
        Authorization: `Bearer ${session.sessionToken}`,
        ...(method === "PUT" ? { "Content-Type": "application/json" } : {}),
      },
      body:
        method === "PUT" && host
          ? JSON.stringify({
              ...host,
              ...(legacyImport ? { legacyImport: true } : {}),
              ...(rejoin ? { rejoin: true } : {}),
            })
          : undefined,
      signal,
    });
    return { response: request, body: await readResponseBody(request, signal) };
  });
  await checkMobileAuthorization(response, session);
  if (response.status === 204 && method === "DELETE") return [];
  if (!response.ok) throw new Error(apiErrorMessage(body) ?? "The account server list could not be synchronized.");
  return decodeAccountServerList(body);
}

export function listAccountServers(session: MobileSession): Promise<AccountServerDirectoryEntry[]> {
  return accountServerRequest(session, "GET");
}

export async function getLegacyAccountServerDirectoryExclusions(session: MobileSession): Promise<string[]> {
  if (!session.localOnly || !session.sessionToken) {
    throw new Error("Sign in to the self-hosted account server to sync the server list.");
  }
  const { response, body } = await withMobileAuthRequestTimeout(async (signal) => {
    const request = await fetch(new URL("/v1/me/servers/legacy-import-exclusions", session.apiUrl).toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      signal,
    });
    return { response: request, body: await readResponseBody(request, signal) };
  });
  await checkMobileAuthorization(response, session);
  if (!response.ok) throw new Error(apiErrorMessage(body) ?? "The account server list could not be synchronized.");
  if (
    !isDynamicRecord(body) ||
    !Array.isArray(body.excludedHostIds) ||
    !body.excludedHostIds.every((hostId) => isString(hostId) && hostId.length > 0)
  ) {
    throw new Error("The account server returned an invalid legacy import exclusion list.");
  }
  return body.excludedHostIds;
}

export function registerAccountServer(
  session: MobileSession,
  host: AccountServerRegistration,
  options: { legacyImport?: boolean; rejoin?: boolean } = {},
): Promise<AccountServerDirectoryEntry[]> {
  return enqueueAccountServerChange(session, {
    id: Crypto.randomUUID(),
    kind: "register",
    server: host,
    ...(options.legacyImport ? { legacyImport: true as const } : {}),
    ...(options.rejoin ? { rejoin: true as const } : {}),
  }).then(async () => {
    await flushPendingAccountServerChanges(session);
    return accountServerRequest(session, "GET");
  });
}

export function removeAccountServer(session: MobileSession, hostId: string): Promise<void> {
  return enqueueAccountServerChange(session, { id: Crypto.randomUUID(), kind: "remove", hostId }).then(async () => {
    await flushPendingAccountServerChanges(session);
  });
}

async function enqueueAccountServerChange(session: MobileSession, change: PendingAccountServerChange): Promise<void> {
  const key = `${ACCOUNT_SERVER_CHANGES_KEY}.${serverOrderKey(session.apiUrl, session.user.id)}`;
  await serializeMobileSessionStorage(async () => {
    const existing = await SecureStore.getItemAsync(key);
    let pending: PendingAccountServerChange[] = [];
    if (existing) {
      try {
        const decoded = JSON.parse(existing);
        if (Array.isArray(decoded)) {
          pending = decoded
            .map(decodePendingAccountServerChange)
            .filter((entry): entry is PendingAccountServerChange => entry !== null);
        }
      } catch {
        pending = [];
      }
    }
    const hostId = change.kind === "register" ? change.server.hostId : change.hostId;
    const next = [
      ...pending.filter((entry) => (entry.kind === "register" ? entry.server.hostId : entry.hostId) !== hostId),
      change,
    ];
    await SecureStore.setItemAsync(key, JSON.stringify(next), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  });
}

async function flushPendingAccountServerChanges(session: MobileSession): Promise<void> {
  const key = `${ACCOUNT_SERVER_CHANGES_KEY}.${serverOrderKey(session.apiUrl, session.user.id)}`;
  const previous = accountServerFlushTails.get(key) ?? Promise.resolve();
  let current: Promise<void>;
  current = previous
    .catch(() => undefined)
    .then(() => flushPendingAccountServerChangesSerial(session, key))
    .finally(() => {
      if (accountServerFlushTails.get(key) === current) accountServerFlushTails.delete(key);
    });
  accountServerFlushTails.set(key, current);
  return current;
}

async function flushPendingAccountServerChangesSerial(session: MobileSession, key: string): Promise<void> {
  for (;;) {
    const change = await serializeMobileSessionStorage(async () => {
      const stored = await SecureStore.getItemAsync(key);
      if (!stored) return null;
      try {
        const decoded = JSON.parse(stored);
        return Array.isArray(decoded) ? decodePendingAccountServerChange(decoded[0]) : null;
      } catch {
        return null;
      }
    });
    if (!change) return;
    if (change.kind === "register") {
      await accountServerRequest(
        session,
        "PUT",
        change.server,
        undefined,
        false,
        change.legacyImport === true,
        change.rejoin === true,
      );
    } else {
      await accountServerRequest(session, "DELETE", undefined, change.hostId, false);
    }
    await serializeMobileSessionStorage(async () => {
      const stored = await SecureStore.getItemAsync(key);
      if (!stored) return;
      try {
        const decoded = JSON.parse(stored);
        if (!Array.isArray(decoded)) return;
        const remaining = decoded.filter((entry) => !isDynamicRecord(entry) || entry.id !== change.id);
        if (remaining.length === 0) {
          await SecureStore.deleteItemAsync(key);
        } else {
          await SecureStore.setItemAsync(key, JSON.stringify(remaining), {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          });
        }
      } catch {
        // Keep the saved queue intact if it cannot be decoded or rewritten.
      }
    });
  }
}

type MobileCredential = Pick<MobileSession, "apiUrl" | "sessionToken">;

export async function redeemMobileConnectUrl(value: string): Promise<MobileSession> {
  if (mobileConnectInFlight) throw new Error(currentText().t("mobile.auth.error.connectionInProgress"));
  mobileConnectInFlight = true;
  try {
    return await redeemMobileConnectSession(value);
  } finally {
    mobileConnectInFlight = false;
  }
}

async function redeemMobileConnectSession(value: string): Promise<MobileSession> {
  void retryMobileSessionRevocations();
  const payload = parseMobileConnectUrl(normalizeMobileConnectLink(value));
  if (!payload) {
    throw new Error(currentText().t("mobile.auth.error.invalidCode"));
  }
  if (!payload.host) throw new Error(currentText().t("mobile.auth.error.codeOutdated"));
  const selfHostedTailnet = isTailscaleApiUrl(payload.apiUrl);

  // Do not consume a one-time ticket or overwrite a permanent legacy token before
  // its revocation is confirmed. Retry cleanup against the OLD account service.
  const current = await serializeMobileSessionStorage(() =>
    selfHostedTailnet ? readStoredLocalIdentitySession() : readStoredSessionAndRevokeInvalid(true),
  );
  // A QR screen can still be finishing its animation after credentials are saved.
  // Protect that handoff too, before its caller updates the React session context.
  if (current) throw new Error(currentText().t("mobile.auth.error.alreadySignedIn"));

  let response: Response;
  let body: unknown;
  try {
    const device = await mobileDeviceIdentity();
    ({ response, body } = await withMobileAuthRequestTimeout(async (signal) => {
      const request = await fetch(new URL("/v1/mobile-auth/redeem", payload.apiUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket: payload.ticket,
          deviceId: device.id,
          deviceName: device.name,
          platform: device.platform,
          ...(selfHostedTailnet ? { hostId: payload.host?.hostId, fingerprint: payload.host?.fingerprint } : {}),
        }),
        signal,
      });
      return { response: request, body: await readResponseBody(request, signal) };
    }));
  } catch {
    const apiUrl = new URL(payload.apiUrl);
    throw new Error(
      apiUrl.protocol === "http:" && isMobileConnectDevelopmentHost(apiUrl.hostname)
        ? currentText().t("mobile.auth.error.desktopUnreachable")
        : currentText().t("mobile.auth.error.accountServiceUnreachable"),
    );
  }

  if (!response.ok) {
    throw new Error(apiErrorMessage(body) ?? currentText().t("mobile.auth.error.codeExpired"));
  }

  const session = decodeMobileSession(body, payload.apiUrl);
  if (selfHostedTailnet && !session.localOnly)
    throw new Error("The Tailscale identity service returned an invalid session.");
  const binding = validateMobileConnectHostBinding(payload.host, session.host);
  session.host = binding;
  if (payload.memberDeviceLink) {
    const host = await pairTailnetInvite(payload.memberDeviceLink, {
      appVersion: mobileAppVersion(),
      randomBytes: (size) => Crypto.getRandomBytes(size),
      displayName: session.user.name,
      accountId: session.user.id,
    });
    if (host.hostId !== binding.hostId || host.fingerprint !== binding.fingerprint) {
      throw new Error("The Mobile Connect QR code contains a different Team server.");
    }
    await saveLocalTailnetServer(host);
    // Sync only verified host metadata. The Team session token remains in this device's secure store.
    // registerAccountServer first persists a token-free change under this account and API URL. If its
    // immediate request fails, listAccountServers retries it on the next directory refresh with the
    // currently signed-in session; a different account cannot consume this queued registration.
    await registerAccountServer(session, accountServerRegistrationForHost(host), { rejoin: true }).catch(
      () => undefined,
    );
  }
  await saveMobileSession(session);
  return session;
}

export async function readMobileSession(): Promise<MobileSession | null> {
  void retryMobileSessionRevocations();
  return serializeMobileSessionStorage(() => readStoredSessionAndRevokeInvalid(false));
}

/** Restores only the identity held by the user's self-hosted account server. */
export async function readLocalIdentitySession(): Promise<MobileSession | null> {
  void retryMobileSessionRevocations();
  return serializeMobileSessionStorage(() => readStoredLocalIdentitySession());
}

/** Returns the last server address used for self-hosted account sign-in. */
export async function readSavedIdentityServerAddress(): Promise<string> {
  const saved = await SecureStore.getItemAsync(LOCAL_IDENTITY_API_URL_KEY);
  if (!saved) return "";
  try {
    return normalizeSelfHostedIdentityApiUrl(saved);
  } catch {
    await SecureStore.deleteItemAsync(LOCAL_IDENTITY_API_URL_KEY);
    return "";
  }
}

/** Stores a validated server address without storing account credentials. */
export async function saveIdentityServerAddress(value: string): Promise<string> {
  const apiUrl = normalizeSelfHostedIdentityApiUrl(value);
  await SecureStore.setItemAsync(LOCAL_IDENTITY_API_URL_KEY, apiUrl, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return apiUrl;
}

export function normalizeIdentityServerAddress(value: string): string | null {
  try {
    return normalizeSelfHostedIdentityApiUrl(value);
  } catch {
    return null;
  }
}

export async function loginToSelfHostedIdentityServer(
  serverAddress: string,
  email: string,
  password: string,
): Promise<MobileSession> {
  if (mobileConnectInFlight) throw new Error(currentText().t("mobile.auth.error.connectionInProgress"));
  mobileConnectInFlight = true;
  try {
    let apiUrl: string;
    try {
      apiUrl = normalizeSelfHostedIdentityApiUrl(serverAddress);
    } catch {
      throw new Error(currentText().t("mobile.auth.error.identityServerAddressInvalid"));
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password)
      throw new Error(currentText().t("mobile.auth.error.identityCredentialsRequired"));

    let response: Response;
    let body: unknown;
    try {
      const device = await mobileDeviceIdentity();
      ({ response, body } = await withMobileAuthRequestTimeout(async (signal) => {
        const request = await fetch(new URL("/v1/auth/login", apiUrl).toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: normalizedEmail,
            password,
            deviceId: device.id,
            deviceName: device.name,
            platform: device.platform,
          }),
          signal,
        });
        return { response: request, body: await readResponseBody(request, signal) };
      }));
    } catch {
      throw new Error(currentText().t("mobile.auth.error.identityServerUnreachable"));
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(currentText().t("mobile.auth.error.identityLoginFailed"));
    }
    if (response.status === 429) {
      throw new Error(currentText().t("mobile.auth.error.identityLoginRateLimited"));
    }
    if (response.status === 404) {
      throw new Error(currentText().t("mobile.auth.error.identityServerUnsupported"));
    }
    if (!response.ok) {
      throw new Error(currentText().t("mobile.auth.error.identityServerUnreachable"));
    }

    const session = decodeMobileSession(body, apiUrl);
    if (!session.localOnly) throw new Error(currentText().t("mobile.auth.error.identityServerUnsupported"));
    await saveMobileSession(session);
    await saveIdentityServerAddress(apiUrl);
    return session;
  } finally {
    mobileConnectInFlight = false;
  }
}

export async function registerSelfHostedIdentityAccount(
  serverAddress: string,
  name: string,
  email: string,
  password: string,
): Promise<MobileSession> {
  if (mobileConnectInFlight) throw new Error(currentText().t("mobile.auth.error.connectionInProgress"));
  mobileConnectInFlight = true;
  try {
    let apiUrl: string;
    try {
      apiUrl = normalizeSelfHostedIdentityApiUrl(serverAddress);
    } catch {
      throw new Error(currentText().t("mobile.auth.error.identityServerAddressInvalid"));
    }
    const normalizedName = validateProfileName(name);
    if (normalizedName.error) throw new Error(currentText().t("mobile.auth.error.identityAccountNameInvalid"));
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password)
      throw new Error(currentText().t("mobile.auth.error.identityCredentialsRequired"));
    if (password.length < 12) throw new Error(currentText().t("mobile.auth.error.identityPasswordTooShort"));

    let response: Response;
    let body: unknown;
    try {
      const device = await mobileDeviceIdentity();
      ({ response, body } = await withMobileAuthRequestTimeout(async (signal) => {
        const request = await fetch(new URL("/v1/auth/register", apiUrl).toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: normalizedName.name,
            email: normalizedEmail,
            password,
            deviceId: device.id,
            deviceName: device.name,
            platform: device.platform,
          }),
          signal,
        });
        return { response: request, body: await readResponseBody(request, signal) };
      }));
    } catch {
      throw new Error(currentText().t("mobile.auth.error.identityServerUnreachable"));
    }

    if (response.status === 409 && isDynamicRecord(body) && body.error === "email_taken") {
      throw new Error(currentText().t("mobile.auth.error.identityEmailTaken"));
    }
    if (response.status === 429) {
      throw new Error(currentText().t("mobile.auth.error.identityLoginRateLimited"));
    }
    if (!response.ok) throw new Error(currentText().t("mobile.auth.error.identityRegistrationFailed"));
    const session = decodeMobileSession(body, apiUrl);
    if (!session.localOnly) throw new Error(currentText().t("mobile.auth.error.identityServerUnsupported"));
    await saveMobileSession(session);
    await saveIdentityServerAddress(apiUrl);
    return session;
  } finally {
    mobileConnectInFlight = false;
  }
}

export function configureMobileLoginCredentials(
  session: MobileSession,
  email: string,
  password: string,
  onUpdated?: (updated: MobileSession) => void,
): Promise<MobileSession> {
  return serializeMobileProfile(async () => {
    if (!session.localOnly || !session.sessionToken)
      throw new Error(currentText().t("mobile.auth.error.identityServerUnsupported"));
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || (!session.user.email && !password))
      throw new Error(currentText().t("mobile.auth.error.identityCredentialsRequired"));
    if (password.length > 0 && password.length < 12)
      throw new Error(currentText().t("mobile.auth.error.identityPasswordTooShort"));

    const { response, body } = await withMobileAuthRequestTimeout(async (signal) => {
      const request = await fetch(new URL("/v1/me/credentials", session.apiUrl).toString(), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: normalizedEmail, password }),
        signal,
      });
      return { response: request, body: await readResponseBody(request, signal) };
    });
    await checkMobileAuthorization(response, session);
    if (response.status === 409 && isDynamicRecord(body)) {
      if (body.error === "email_taken") throw new Error(currentText().t("mobile.auth.error.identityEmailTaken"));
      if (body.error === "setup_completed")
        throw new Error(currentText().t("mobile.auth.error.identityCredentialsAlreadySet"));
    }
    if (!response.ok) throw new Error(currentText().t("mobile.auth.error.identityCredentialsSaveFailed"));
    const user = decodeUser(body);
    if (user.id !== session.user.id) throw new Error("The account service returned an invalid user.");
    const updated = { ...session, user };
    await saveMobileSessionIfCurrent(updated);
    onUpdated?.(updated);
    return updated;
  });
}

async function readStoredLocalIdentitySession(): Promise<MobileSession | null> {
  const stored = await SecureStore.getItemAsync(LOCAL_IDENTITY_SESSION_KEY);
  if (!stored) return null;
  let session: MobileSession;
  try {
    session = decodeStoredMobileSession(JSON.parse(stored));
    if (!session.localOnly) throw new Error("Invalid local identity session.");
    session.apiUrl = normalizeSelfHostedIdentityApiUrl(session.apiUrl);
  } catch {
    await SecureStore.deleteItemAsync(LOCAL_IDENTITY_SESSION_KEY);
    return null;
  }
  try {
    const validated = await refreshMobileProfile(session);
    return validated?.localOnly ? validated : null;
  } catch {
    // Preserve the last shared profile while its Linux authority is offline. The stored bearer
    // token remains encrypted; Team API requests still fail normally until the host returns.
    return session;
  }
}

// Called only inside the storage queue. Invalid sessions are never returned to
// the workspace, even offline. Retain their encrypted credential solely for
// revocation retries on startup or before the next QR redemption; these tokens
// deliberately never expire and must not be silently discarded or overwritten.
async function readStoredSessionAndRevokeInvalid(requireRevocation: boolean): Promise<MobileSession | null> {
  const stored = await SecureStore.getItemAsync(MOBILE_SESSION_KEY);
  if (!stored) return null;
  let credential: MobileCredential | null = null;
  try {
    const value = JSON.parse(stored);
    credential = decodeStoredMobileCredential(value);
    const storedCredential = credential;
    if ((await readPendingRevocations()).some((pending) => sameCredential(pending, storedCredential))) {
      await SecureStore.deleteItemAsync(MOBILE_SESSION_KEY);
      return null;
    }
    return decodeStoredMobileSession(value);
  } catch {
    if (credential) {
      try {
        await revokeMobileCredential(credential);
      } catch {
        if (requireRevocation) {
          throw new Error(currentText().t("mobile.auth.error.revokePreviousFailed"));
        }
        return null;
      }
    }
    await SecureStore.deleteItemAsync(MOBILE_SESSION_KEY);
    return null;
  }
}

export function validateMobileSession(
  session: MobileSession,
  onValidated?: (validated: MobileSession | null) => void,
): Promise<MobileSession | null> {
  void retryMobileSessionRevocations();
  return serializeMobileProfile(async () => {
    const validated = await refreshMobileProfile(session);
    onValidated?.(validated);
    return validated;
  });
}

async function refreshMobileProfile(session: MobileSession): Promise<MobileSession | null> {
  const { response, body } = await withMobileAuthRequestTimeout(async (signal) => {
    const request = await fetch(new URL("/v1/mobile-auth/session", session.apiUrl).toString(), {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      signal,
    });
    return { response: request, body: await readResponseBody(request, signal) };
  });
  if (response.status === 401) {
    await deleteMobileSessionIfCurrent(session.sessionToken);
    return null;
  }
  if (!response.ok) {
    throw new Error(apiErrorMessage(body) ?? currentText().t("mobile.auth.error.verifyFailed"));
  }
  const user = decodeUser(body);
  if (user.id !== session.user.id) throw new Error("The account service returned an invalid user.");
  const updated = sameUser(user, session.user) ? session : { ...session, user };
  await saveMobileSessionIfCurrent(updated);
  return updated;
}

const accountSessionSchema = z.object({
  sessionId: z.string().uuid(),
  name: z.string(),
  kind: z.enum(["desktop", "mobile"]),
  current: z.boolean(),
  connectedAt: z.number().finite(),
  lastActiveAt: z.number().finite(),
});
export type MobileAccountSession = z.infer<typeof accountSessionSchema>;

export async function listMobileAccountSessions(
  session: MobileSession,
  signal?: AbortSignal,
): Promise<MobileAccountSession[]> {
  return withMobileAuthRequestTimeout(async (signal) => {
    const response = await fetch(new URL("/v1/mobile-auth/devices?includeDesktop=true", session.apiUrl).toString(), {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      signal,
    });
    await checkMobileAuthorization(response, session);
    if (!response.ok) throw new Error(currentText().t("mobile.auth.error.sessionsLoadFailed"));
    return z.object({ sessions: z.array(accountSessionSchema) }).parse(await response.json()).sessions;
  }, signal);
}

export async function revokeMobileAccountSession(session: MobileSession, target: MobileAccountSession): Promise<void> {
  if (target.current) throw new Error(currentText().t("mobile.auth.error.useSignOut"));
  if (target.kind === "desktop") throw new Error(currentText().t("mobile.auth.error.desktopSession"));
  await withMobileAuthRequestTimeout(async (signal) => {
    const response = await fetch(
      new URL(
        `/v1/mobile-auth/devices/${encodeURIComponent(target.sessionId)}?includeDesktop=true`,
        session.apiUrl,
      ).toString(),
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        signal,
      },
    );
    await checkMobileAuthorization(response, session);
    if (!response.ok) throw new Error(currentText().t("mobile.auth.error.disconnectFailed"));
  });
}

export type MobileProfileChange = { name: string } | { avatar: { bytes: Uint8Array; mimeType: AvatarMimeType } | null };

export function updateMobileProfile(
  session: MobileSession,
  change: MobileProfileChange,
  onUpdated?: (updated: MobileSession) => void,
): Promise<MobileSession> {
  return serializeMobileProfile(async () => {
    const updated = await writeMobileProfile(session, change);
    onUpdated?.(updated);
    return updated;
  });
}

async function writeMobileProfile(session: MobileSession, change: MobileProfileChange): Promise<MobileSession> {
  if ("name" in change && validateProfileName(change.name).error) {
    throw new Error(currentText().t("mobile.auth.error.nameLength"));
  }
  if ("avatar" in change && change.avatar) {
    if (change.avatar.bytes.byteLength > AVATAR_IMAGE_LIMITS.storedBytes)
      throw new Error(currentText().t("mobile.auth.error.photoTooLarge"));
    if (!isValidAvatarImage(change.avatar.mimeType, change.avatar.bytes)) {
      throw new Error(currentText().t("mobile.auth.error.photoInvalid"));
    }
  }
  const isName = "name" in change;
  const { response, body } = await withMobileAuthRequestTimeout(async (signal) => {
    const request = await fetch(new URL(isName ? "/v1/me/profile" : "/v1/me/avatar", session.apiUrl).toString(), {
      method: isName ? "PATCH" : change.avatar ? "PUT" : "DELETE",
      headers: {
        Authorization: `Bearer ${session.sessionToken}`,
        ...(isName
          ? { "Content-Type": "application/json" }
          : change.avatar
            ? { "Content-Type": change.avatar.mimeType }
            : {}),
      },
      body: isName
        ? JSON.stringify({ name: validateProfileName(change.name).name })
        : change.avatar
          ? new Uint8Array(change.avatar.bytes).buffer
          : undefined,
      signal,
    });
    return { response: request, body: await readResponseBody(request, signal) };
  });
  await checkMobileAuthorization(response, session);
  if (!response.ok) {
    if (response.status === 429) throw new Error(currentText().t("mobile.auth.error.tooManyChanges"));
    if (response.status === 409) throw new Error(currentText().t("mobile.auth.error.photoConflict"));
    throw new Error(currentText().t("mobile.auth.error.profileSaveFailed"));
  }
  const user = decodeUser(body);
  if (user.id !== session.user.id) throw new Error("The account service returned an invalid user.");
  const updated = { ...session, user };
  await saveMobileSessionIfCurrent(updated);
  return updated;
}

export async function logoutMobileSession(session: MobileSession): Promise<void> {
  await serializeMobileSessionStorage(async () => {
    const pending = await readPendingRevocations();
    if (!pending.some((item) => sameCredential(item, session))) {
      pending.push({ apiUrl: session.apiUrl, sessionToken: session.sessionToken });
      await SecureStore.setItemAsync(MOBILE_REVOCATIONS_KEY, JSON.stringify(pending), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      revocationRetryRequested = true;
    }
    const key = session.localOnly ? LOCAL_IDENTITY_SESSION_KEY : MOBILE_SESSION_KEY;
    const stored = await SecureStore.getItemAsync(key);
    if (stored && sameCredential(decodeStoredMobileCredential(JSON.parse(stored)), session)) {
      await SecureStore.deleteItemAsync(key);
    }
  });
  void retryMobileSessionRevocations();
}

function sameCredential(left: MobileCredential, right: MobileCredential): boolean {
  return left.apiUrl === right.apiUrl && left.sessionToken === right.sessionToken;
}

async function readPendingRevocations(): Promise<MobileCredential[]> {
  const stored = await SecureStore.getItemAsync(MOBILE_REVOCATIONS_KEY);
  if (!stored) return [];
  return z.array(z.unknown()).parse(JSON.parse(stored)).map(decodeStoredMobileCredential);
}

let revocationRetry: Promise<void> | null = null;
let revocationRetryRequested = false;

// Pending tokens are never restored as logins. Keep them in Keychain until the
// account service confirms revocation, without blocking local sign-out or login.
export function retryMobileSessionRevocations(): Promise<void> {
  if (revocationRetry) return revocationRetry;
  revocationRetry = (async () => {
    const attempted: MobileCredential[] = [];
    try {
      do {
        revocationRetryRequested = false;
        const pending = (await serializeMobileSessionStorage(readPendingRevocations)).filter(
          (credential) => !attempted.some((item) => sameCredential(item, credential)),
        );
        attempted.push(...pending);
        await Promise.all(
          pending.map(async (credential) => {
            try {
              await revokeMobileCredential(credential);
              await serializeMobileSessionStorage(async () => {
                const remaining = (await readPendingRevocations()).filter((item) => !sameCredential(item, credential));
                if (remaining.length === 0) {
                  await SecureStore.deleteItemAsync(MOBILE_REVOCATIONS_KEY);
                } else {
                  await SecureStore.setItemAsync(MOBILE_REVOCATIONS_KEY, JSON.stringify(remaining), {
                    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
                  });
                }
              });
            } catch {
              // Retry failed credentials only on the next external trigger.
            }
          }),
        );
      } while (revocationRetryRequested);
    } catch {
      // A storage failure must not produce an unhandled background rejection.
    } finally {
      revocationRetry = null;
    }
  })();
  return revocationRetry;
}

async function revokeMobileCredential(session: MobileCredential): Promise<void> {
  try {
    await withMobileAuthRequestTimeout(async (signal) => {
      const response = await fetch(new URL("/v1/mobile-auth/session", session.apiUrl).toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        signal,
      });
      if (!response.ok) throw new Error("The account service did not confirm revocation.");
    });
  } catch {
    // Revocation may have committed before DELETE timed out, lost its response,
    // or failed while notifying peers. Check the token instead of treating an
    // ambiguous transport result as proof that the session is still active.
    try {
      const revoked = await withMobileAuthRequestTimeout(async (signal) => {
        const response = await fetch(new URL("/v1/mobile-auth/session", session.apiUrl).toString(), {
          headers: { Authorization: `Bearer ${session.sessionToken}` },
          signal,
        });
        return response.status === 401;
      });
      if (revoked) return;
    } catch {
      // Without confirmation, keep the credential available for another attempt.
    }
    throw new Error(currentText().t("mobile.auth.error.signOutUnconfirmed"));
  }
}

// Serialize profile reads and writes so a foreground refresh cannot persist an older identity
// after a successful edit. Credential revocation uses the independent storage queue.
function serializeMobileProfile<T>(operation: () => Promise<T>): Promise<T> {
  const result = mobileProfileTail.then(operation, operation);
  mobileProfileTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * One signed-in request to the account server. A 401 ends the session. A failed request throws the
 * account server's message, or `failure`. A body that `decode` refuses throws `failure` too.
 */
export async function requestMobileAccount<T>(
  session: MobileSession,
  path: string,
  init: { method?: "GET" | "POST"; body?: string; headers?: Record<string, string> },
  decode: (value: unknown) => T | null,
  failure: string,
  timeoutMs?: number,
): Promise<T> {
  return withMobileAuthRequestTimeout(
    async (signal) => {
      let response: Response;
      try {
        response = await fetch(new URL(path, session.apiUrl).toString(), {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${session.sessionToken}`,
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...init.headers,
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          signal,
        });
      } catch {
        throw new Error(failure);
      }
      await checkMobileAuthorization(response, session);
      const body = await readResponseBody(response, signal).catch(() => null);
      if (!response.ok) throw new Error(apiErrorMessage(body) ?? failure);
      const value = decode(body);
      if (value === null) throw new Error(failure);
      return value;
    },
    undefined,
    timeoutMs,
  );
}

async function checkMobileAuthorization(response: Response, session: MobileSession): Promise<void> {
  if (response.status !== 401) return;
  await deleteMobileSessionIfCurrent(session.sessionToken);
  throw new MobileSessionExpiredError();
}

async function withMobileAuthRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = MOBILE_AUTH_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function readResponseBody(response: Response, signal: AbortSignal): Promise<DynamicRecord | null> {
  try {
    const body = await response.json();
    return isDynamicRecord(body) ? body : null;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

async function saveMobileSession(session: MobileSession): Promise<void> {
  const key = session.localOnly ? LOCAL_IDENTITY_SESSION_KEY : MOBILE_SESSION_KEY;
  await serializeMobileSessionStorage(() =>
    SecureStore.setItemAsync(key, JSON.stringify(session), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  );
}

async function saveMobileSessionIfCurrent(session: MobileSession): Promise<void> {
  const key = session.localOnly ? LOCAL_IDENTITY_SESSION_KEY : MOBILE_SESSION_KEY;
  await serializeMobileSessionStorage(async () => {
    const stored = await SecureStore.getItemAsync(key);
    if (!stored) return;
    try {
      if (decodeStoredMobileSession(JSON.parse(stored)).sessionToken !== session.sessionToken) return;
    } catch {
      return;
    }
    await SecureStore.setItemAsync(key, JSON.stringify(session), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  });
}

async function deleteMobileSessionIfCurrent(sessionToken: string): Promise<void> {
  await serializeMobileSessionStorage(async () => {
    for (const key of [LOCAL_IDENTITY_SESSION_KEY, MOBILE_SESSION_KEY]) {
      const stored = await SecureStore.getItemAsync(key);
      if (!stored) continue;
      try {
        if (decodeStoredMobileCredential(JSON.parse(stored)).sessionToken === sessionToken)
          await SecureStore.deleteItemAsync(key);
      } catch {
        // Corrupt credentials cannot identify the session that is being invalidated.
      }
    }
  });
}

function serializeMobileSessionStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = mobileSessionStorageTail.then(operation, operation);
  mobileSessionStorageTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function mobileDeviceIdentity(): Promise<{
  id: string;
  name: string;
  platform: "ios" | "android" | "unknown";
}> {
  let id = await SecureStore.getItemAsync(MOBILE_DEVICE_ID_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(MOBILE_DEVICE_ID_KEY, id, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  const rawName = Device.deviceName?.trim() || Device.modelName?.trim() || id;
  const name = rawName.normalize("NFC").replace(/\p{C}/gu, "").replace(/\s+/gu, " ").slice(0, 80).trim();
  const platform = isIOS ? "ios" : isAndroid ? "android" : "unknown";
  return { id, name: name || id, platform };
}

function normalizeSelfHostedIdentityApiUrl(value: string): string {
  if (value.trim().length === 0 || value.length > 2048) throw new Error("Invalid server address.");
  const url = new URL(value.trim());
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Invalid server address.");
  }
  if (url.protocol === "http:") {
    if (!url.port) url.port = LOCAL_IDENTITY_DEFAULT_PORT;
    if (!isPrivateIdentityHost(url.hostname) && !isTailscaleApiUrl(url.toString())) {
      throw new Error("Use HTTPS outside a private network.");
    }
  }
  return url.origin;
}

function isPrivateIdentityHost(hostname: string): boolean {
  const address =
    hostname
      .replace(/^\[|\]$/gu, "")
      .split("%", 1)[0]
      ?.toLowerCase() ?? "";
  if (address === "localhost" || address === "::1" || address.endsWith(".ts.net")) return true;
  const v4 = address.split(".").map(Number);
  if (v4.length === 4 && v4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const first = v4[0] ?? -1;
    const second = v4[1] ?? -1;
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 127 && second === 0) ||
      (first === 169 && second === 254)
    );
  }
  const firstGroup = Number.parseInt(address.split(":", 1)[0] ?? "", 16);
  return address.includes(":") && (address === "::1" || (firstGroup >= 0xfc00 && firstGroup <= 0xfdff));
}

function decodeMobileSession(value: unknown, apiUrl: string): MobileSession {
  if (!isDynamicRecord(value) || !isString(value.sessionToken) || value.sessionToken.length > 512) {
    throw new Error("The account service returned an invalid mobile session.");
  }
  const localOnly = value.localOnly === true;
  if (!localOnly && !isMobileConnectHostBinding(value.host)) throw new Error("The mobile session host is invalid.");
  const host = isMobileConnectHostBinding(value.host) ? value.host : undefined;
  return {
    apiUrl,
    sessionToken: value.sessionToken,
    user: decodeUser(value.user),
    ...(host ? { host } : {}),
    ...(localOnly ? { localOnly: true } : {}),
  };
}

function decodeStoredMobileSession(value: unknown): MobileSession {
  const credential = decodeStoredMobileCredential(value);
  return decodeMobileSession(value, credential.apiUrl);
}

// This minimal decoder is only for cleanup, never for restoring authentication.
function decodeStoredMobileCredential(value: unknown): MobileCredential {
  if (
    !isDynamicRecord(value) ||
    !isString(value.apiUrl) ||
    !isString(value.sessionToken) ||
    !value.sessionToken ||
    value.sessionToken.length > 512
  )
    throw new Error("Invalid stored mobile credential.");
  let apiUrl: string;
  try {
    apiUrl = normalizeSelfHostedIdentityApiUrl(value.apiUrl);
  } catch {
    const parsed = parseMobileConnectUrl(
      `openbot://mobile-connect?api=${encodeURIComponent(value.apiUrl)}&ticket=${"x".repeat(32)}`,
    );
    if (!parsed) throw new Error("Invalid stored account API.");
    apiUrl = parsed.apiUrl;
  }
  return { apiUrl, sessionToken: value.sessionToken };
}

function decodeUser(value: unknown): CentralAuthUser {
  if (!isDynamicRecord(value) || !isString(value.id) || !isString(value.email)) {
    throw new Error("The account service returned an invalid user.");
  }
  if (value.name !== null && !isString(value.name)) throw new Error("The account service returned an invalid user.");
  if (value.avatarUrl !== null && !isString(value.avatarUrl)) {
    throw new Error("The account service returned an invalid user.");
  }
  return { id: value.id, email: value.email, name: value.name, avatarUrl: value.avatarUrl };
}

function sameUser(left: CentralAuthUser, right: CentralAuthUser): boolean {
  return (
    left.id === right.id && left.email === right.email && left.name === right.name && left.avatarUrl === right.avatarUrl
  );
}

function apiErrorMessage(value: unknown): string | null {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.error) || !isString(value.error.message)) return null;
  return value.error.message.length <= 240 ? value.error.message : null;
}
