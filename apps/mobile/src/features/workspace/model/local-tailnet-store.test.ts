// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const secureStore = vi.hoisted(() => ({ values: new Map<string, string>() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => secureStore.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => secureStore.values.set(key, value),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
}));

import {
  decodeLocalTailnetServers,
  readLocalTailnetServers,
  removeLocalTailnetServer,
  saveLocalTailnetServer,
} from "./local-tailnet-store";

const host = (accountId: string | undefined, sessionToken: string) => ({
  hostId: "shared-host",
  name: "Shared host",
  logoKey: null,
  apiUrl: "http://100.100.10.2:43123/",
  publicKey: "host-key",
  fingerprint: "a".repeat(43),
  sessionToken,
  membershipId: "membership",
  role: "member" as const,
  ...(accountId ? { accountId } : {}),
});

afterEach(() => secureStore.values.clear());

describe("local Tailnet server credentials", () => {
  it("keeps per-account tokens for the same host separate", async () => {
    await saveLocalTailnetServer(host("account-a", "token-a"));
    await saveLocalTailnetServer(host("account-b", "token-b"));
    await saveLocalTailnetServer(host("account-a", "token-a2"));

    await expect(readLocalTailnetServers()).resolves.toEqual([
      host("account-b", "token-b"),
      host("account-a", "token-a2"),
    ]);
  });

  it("does not treat another account's host pairing as a duplicate", () => {
    expect(() => decodeLocalTailnetServers([host("account-a", "token-a"), host("account-b", "token-b")])).not.toThrow();
    expect(() => decodeLocalTailnetServers([host("account-a", "token-a"), host("account-a", "token-b")])).toThrow(
      "contains duplicates",
    );
  });

  it("removes only the signed-in account pairing and any unclaimed legacy pairing", async () => {
    await saveLocalTailnetServer(host("account-a", "token-a"));
    await saveLocalTailnetServer(host("account-b", "token-b"));
    await saveLocalTailnetServer(host(undefined, "legacy-token"));

    await removeLocalTailnetServer("shared-host", "account-b");

    await expect(readLocalTailnetServers()).resolves.toEqual([host("account-a", "token-a")]);
  });

  it("removes only an unclaimed pairing when no account is specified", async () => {
    await saveLocalTailnetServer(host("account-a", "token-a"));
    await saveLocalTailnetServer(host(undefined, "legacy-token"));

    await removeLocalTailnetServer("shared-host");

    await expect(readLocalTailnetServers()).resolves.toEqual([host("account-a", "token-a")]);
  });
});
