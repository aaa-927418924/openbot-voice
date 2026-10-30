import { isTailscaleApiUrl } from "@openbot/contracts/invite-links";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import * as SecureStore from "expo-secure-store";
import type { LocalTailnetServer } from "./local-tailnet";

const LOCAL_TAILNET_SERVERS_KEY = "openbot.mobile.local-tailnet.v1";

let writes = Promise.resolve();

export function decodeLocalTailnetServers(value: unknown): LocalTailnetServer[] {
  if (!Array.isArray(value)) throw new Error("The saved Tailscale host list is invalid.");
  const hosts = value.map((entry): LocalTailnetServer => {
    if (
      !isDynamicRecord(entry) ||
      !isString(entry.hostId) ||
      !isString(entry.name) ||
      !(entry.logoKey === null || isString(entry.logoKey)) ||
      !isString(entry.apiUrl) ||
      !isString(entry.publicKey) ||
      !isString(entry.fingerprint) ||
      !isString(entry.sessionToken) ||
      !isString(entry.membershipId) ||
      !(
        entry.accountId === undefined ||
        (isString(entry.accountId) && entry.accountId.length > 0 && entry.accountId.length <= 128)
      ) ||
      (entry.role !== "owner" && entry.role !== "admin" && entry.role !== "member")
    ) {
      throw new Error("The saved Tailscale host list is invalid.");
    }
    const url = new URL(entry.apiUrl);
    if (!isTailscaleApiUrl(url.toString()) || !/^[A-Za-z0-9_-]{43}$/u.test(entry.fingerprint)) {
      throw new Error("The saved Tailscale host address is invalid.");
    }
    return {
      hostId: entry.hostId,
      name: entry.name,
      logoKey: entry.logoKey,
      apiUrl: url.toString(),
      publicKey: entry.publicKey,
      fingerprint: entry.fingerprint,
      sessionToken: entry.sessionToken,
      membershipId: entry.membershipId,
      role: entry.role,
      ...(isString(entry.accountId) ? { accountId: entry.accountId } : {}),
    };
  });
  if (new Set(hosts.map((host) => JSON.stringify([host.hostId, host.accountId ?? null]))).size !== hosts.length)
    throw new Error("The saved Tailscale host list contains duplicates.");
  return hosts;
}

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation, operation);
  writes = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function readLocalTailnetServers(): Promise<LocalTailnetServer[]> {
  return serialized(async () => {
    const stored = await SecureStore.getItemAsync(LOCAL_TAILNET_SERVERS_KEY);
    if (!stored) return [];
    return decodeLocalTailnetServers(JSON.parse(stored));
  });
}

export async function saveLocalTailnetServer(server: LocalTailnetServer): Promise<void> {
  await serialized(async () => {
    const stored = await SecureStore.getItemAsync(LOCAL_TAILNET_SERVERS_KEY);
    const current = stored ? decodeLocalTailnetServers(JSON.parse(stored)) : [];
    const next = decodeLocalTailnetServers([
      ...current.filter((host) => host.hostId !== server.hostId || host.accountId !== server.accountId),
      server,
    ]);
    await SecureStore.setItemAsync(LOCAL_TAILNET_SERVERS_KEY, JSON.stringify(next), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  });
}

export async function removeLocalTailnetServer(hostId: string, accountId?: string): Promise<void> {
  await serialized(async () => {
    const stored = await SecureStore.getItemAsync(LOCAL_TAILNET_SERVERS_KEY);
    const current = stored ? decodeLocalTailnetServers(JSON.parse(stored)) : [];
    await SecureStore.setItemAsync(
      LOCAL_TAILNET_SERVERS_KEY,
      JSON.stringify(
        current.filter(
          (host) => host.hostId !== hostId || (host.accountId !== undefined && host.accountId !== accountId),
        ),
      ),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
  });
}
