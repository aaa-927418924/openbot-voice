// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountServerDirectoryEntry } from "@openbot/contracts/account-server-directory";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalProfileStore } from "./local-profile-store";
import { SelfHostedDesktopAccountManager } from "./self-hosted-desktop-account";

const roots: string[] = [];
const password = "local-account-password-123";

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createAccountManager(cipherCanPersist = true) {
  const root = await mkdtemp(join(tmpdir(), "openbot-self-hosted-desktop-account-"));
  roots.push(root);
  const profilePath = join(root, "local-profile.json");
  const profile = new LocalProfileStore(profilePath);
  await Effect.runPromise(profile.load());
  const manager = new SelfHostedDesktopAccountManager({
    path: join(root, "account.json"),
    profile,
    cipher: {
      canPersist: () => cipherCanPersist,
      encrypt: (value) => Buffer.from(`encrypted:${value}`),
      decrypt: (value) => value.toString().replace(/^encrypted:/u, ""),
    },
  });
  await manager.initialize();
  return { manager, profilePath, root };
}

describe("SelfHostedDesktopAccountManager", () => {
  it("signs out of the account session without deleting this computer's profile", async () => {
    const { manager, profilePath, root } = await createAccountManager();
    const profileBefore = await readFile(profilePath);
    const token = "a".repeat(43);
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/v1/auth/login") {
        return Response.json({
          sessionToken: token,
          user: { id: "account-1", email: "person@example.com", name: "Person", avatarUrl: null },
        });
      }
      if (url.pathname === "/v1/mobile-auth/session" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", request);

    await Effect.runPromise(
      manager.signIn({
        serverAddress: "http://100.100.10.2:43124",
        email: "Person@example.com",
        password,
      }),
    );
    const accountFile = join(root, "account.json");
    const stored = await readFile(accountFile, "utf8");
    expect(manager.getState()).toMatchObject({ status: "signed_in", user: { email: "person@example.com" } });
    expect(stored).not.toContain(password);

    expect(await Effect.runPromise(manager.logout())).toEqual({ status: "signed_out" });
    expect(request).toHaveBeenLastCalledWith(
      new URL("/v1/mobile-auth/session", "http://100.100.10.2:43124/"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) }),
    );
    expect(JSON.parse(await readFile(accountFile, "utf8"))).toMatchObject({
      mode: "signed_out",
      encryptedToken: null,
      user: null,
    });
    expect(await readFile(profilePath)).toEqual(profileBefore);
  });

  it("loads and registers the signed-in account's device-independent server list", async () => {
    const { manager } = await createAccountManager();
    const token = "b".repeat(43);
    const entry: AccountServerDirectoryEntry = {
      hostId: "linux-host",
      name: "Linux host",
      apiUrl: "http://100.100.10.2:43123",
      fingerprint: "host-fingerprint",
      publicKey: "host-public-key",
      logoKey: null,
      membershipId: "membership-1",
      role: "owner",
      isOwner: true,
    };
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/v1/auth/login") {
        return Response.json({
          sessionToken: token,
          user: { id: "account-2", email: "person@example.com", name: "Person", avatarUrl: null },
        });
      }
      if (url.pathname === "/v1/me/servers" && (init?.method ?? "GET") === "GET") {
        return Response.json({ servers: [entry] });
      }
      if (url.pathname === "/v1/me/servers" && init?.method === "PUT") return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", request);

    await Effect.runPromise(
      manager.signIn({ serverAddress: "http://100.100.10.2:43124", email: "person@example.com", password }),
    );
    expect(await Effect.runPromise(manager.listAccountServers())).toEqual([entry]);
    const registration = {
      hostId: entry.hostId,
      name: entry.name,
      apiUrl: entry.apiUrl,
      fingerprint: entry.fingerprint,
      publicKey: entry.publicKey,
      logoKey: entry.logoKey,
      membershipId: entry.membershipId,
      role: entry.role,
    };
    await Effect.runPromise(manager.registerAccountServer(registration));
    expect(request).toHaveBeenLastCalledWith(
      new URL("/v1/me/servers", "http://100.100.10.2:43124/"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify(registration),
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      }),
    );
  });

  it("does not send credentials when this device cannot store a session securely", async () => {
    const { manager } = await createAccountManager(false);
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);

    await expect(
      Effect.runPromise(
        manager.signIn({ serverAddress: "http://100.100.10.2:43124", email: "person@example.com", password }),
      ),
    ).rejects.toThrow("安全なログイン保存");
    expect(request).not.toHaveBeenCalled();
  });
});
