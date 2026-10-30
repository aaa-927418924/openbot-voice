// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { remoteHostFingerprint } from "@openbot/team-client/remote-directory";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SelfHostedAccountServerDirectory } from "./self-hosted-account-server-directory";
import { SelfHostedIdentityApiServer, selfHostedTeamProfile } from "./self-hosted-identity-api";
import { SelfHostedIdentityAuthority } from "./self-hosted-identity-authority";

const roots: string[] = [];
const avatarBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const profile = {
  id: "local-owner-id",
  name: "Linux owner",
  avatarUrl: `data:image/png;base64,${avatarBytes.toString("base64")}`,
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SelfHostedIdentityApiServer", () => {
  it("redeems a host-bound QR, issues a one-host Team ticket, and applies shared profile edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-self-hosted-identity-api-"));
    roots.push(root);
    const authority = new SelfHostedIdentityAuthority({ path: join(root, "identity.json") });
    await Effect.runPromise(authority.initialize());
    const account = await Effect.runPromise(authority.ensureLocalAccount(profile));
    await Effect.runPromise(
      authority.configureLoginCredentials({ email: "Owner@OpenBot.test", password: "central-password-123" }),
    );
    const pair = await Effect.runPromise(
      authority.issueMobileConnectTicket({
        accountId: account.id,
        hostId: "linux-team-host",
        fingerprint: "f".repeat(43),
      }),
    );
    const changed: unknown[] = [];
    const api = new SelfHostedIdentityApiServer({
      authority,
      serverDirectory: new SelfHostedAccountServerDirectory(join(root, "server-directory.json")),
      isOwnerOfHost: (accountId, hostId) => accountId === account.id && hostId === "linux-team-host",
      port: 0,
      listen: (server: Server) =>
        new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") return reject(new Error("No listener address."));
            resolve({ address: "127.0.0.1", family: 4, port: address.port });
          });
        }),
      onProfileChanged: async (user) => {
        changed.push(user);
      },
    });
    const apiUrl = await api.start();

    try {
      const redeem = await fetch(new URL("/v1/mobile-auth/redeem", apiUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({
          ticket: pair.ticket,
          hostId: "linux-team-host",
          fingerprint: "f".repeat(43),
          deviceId: "stable-device-id",
          deviceName: "Pixel 7a",
          platform: "android",
        }),
      });
      expect(redeem.status).toBe(200);
      const sessionBody = await redeem.json();
      if (
        !isDynamicRecord(sessionBody) ||
        typeof sessionBody.sessionToken !== "string" ||
        !isDynamicRecord(sessionBody.user) ||
        typeof sessionBody.user.id !== "string" ||
        typeof sessionBody.user.email !== "string"
      ) {
        throw new Error("The login response has an invalid shape.");
      }
      const sessionToken = sessionBody.sessionToken;
      expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(sessionBody.user).toMatchObject({ id: account.id, email: "owner@openbot.test" });
      expect(sessionBody.localOnly).toBe(true);

      const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyForDirectoryTest";
      const registration = await fetch(new URL("/v1/me/servers", apiUrl), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({
          hostId: "linux-team-host",
          name: "Cloud host",
          apiUrl: "http://100.100.10.2:43123",
          fingerprint: remoteHostFingerprint(publicKey),
          publicKey,
          logoKey: null,
          membershipId: "owner-membership",
          role: "owner",
        }),
      });
      expect(registration.status).toBe(200);
      expect(await registration.json()).toMatchObject({
        servers: [
          {
            hostId: "linux-team-host",
            apiUrl: "http://100.100.10.2:43123",
            isOwner: true,
            role: "owner",
          },
        ],
      });
      const rename = await fetch(new URL("/v1/me/servers", apiUrl), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({
          hostId: "linux-team-host",
          name: "Renamed host",
          apiUrl: "http://100.100.10.2:43123",
          fingerprint: remoteHostFingerprint(publicKey),
          publicKey,
          logoKey: null,
          membershipId: "owner-membership",
          role: "owner",
        }),
      });
      expect(await rename.json()).toMatchObject({ servers: [{ name: "Renamed host" }] });

      const otherAccount = await Effect.runPromise(
        authority.registerAccount({
          email: "other@openbot.test",
          password: "other-account-password",
          name: "Other account",
        }),
      );
      const otherList = await fetch(new URL("/v1/me/servers", apiUrl), {
        headers: { Authorization: `Bearer ${otherAccount.token}`, Connection: "close" },
      });
      expect(await otherList.json()).toEqual({ servers: [] });
      const otherRegistration = await fetch(new URL("/v1/me/servers", apiUrl), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${otherAccount.token}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({
          hostId: "linux-team-host",
          name: "Renamed host",
          apiUrl: "http://100.100.10.2:43123",
          fingerprint: remoteHostFingerprint(publicKey),
          publicKey,
          logoKey: null,
          membershipId: "other-membership",
          role: "member",
        }),
      });
      expect(otherRegistration.status).toBe(200);

      const directoryReadback = new SelfHostedAccountServerDirectory(join(root, "server-directory.json"));
      await directoryReadback.initialize();
      expect(await directoryReadback.list(account.id)).toMatchObject([
        { hostId: "linux-team-host", name: "Renamed host", isOwner: false, role: "member" },
      ]);
      await directoryReadback.register(account.id, {
        hostId: "second-team-host",
        name: "Second host",
        apiUrl: "http://100.100.10.3:43123",
        fingerprint: remoteHostFingerprint(publicKey),
        publicKey,
        logoKey: null,
        membershipId: "second-membership",
        role: "member",
      });
      await directoryReadback.setServerVisible("linux-team-host", false);
      await directoryReadback.setServerVisible("second-team-host", false);
      expect(await directoryReadback.list(account.id)).toEqual([]);
      expect(await directoryReadback.list(otherAccount.account.id)).toEqual([]);
      expect(await directoryReadback.legacyImportExclusions(account.id)).toEqual(
        expect.arrayContaining(["linux-team-host", "second-team-host"]),
      );

      const visibilityAfterRestart = new SelfHostedAccountServerDirectory(join(root, "server-directory.json"));
      await visibilityAfterRestart.initialize();
      expect(await visibilityAfterRestart.list(account.id)).toEqual([]);
      await visibilityAfterRestart.setServerVisible("linux-team-host", true);
      expect(await visibilityAfterRestart.list(account.id)).toMatchObject([
        { hostId: "linux-team-host", name: "Renamed host" },
      ]);
      expect(await visibilityAfterRestart.list(account.id)).toHaveLength(1);
      expect(await visibilityAfterRestart.list(otherAccount.account.id)).toMatchObject([
        { hostId: "linux-team-host", membershipId: "other-membership" },
      ]);
      expect(
        selfHostedTeamProfile(
          { id: account.id, email: account.email, name: account.name, avatarUrl: account.avatarUrl },
          "http://100.100.10.2:43124",
        ).avatarUrl,
      ).toBe(`http://100.100.10.2:43124/v1/profile/avatar?account=${account.id}`);
      const avatar = await fetch(new URL("/v1/profile/avatar", apiUrl));
      expect(avatar.status).toBe(200);
      expect(avatar.headers.get("Content-Type")).toBe("image/png");
      expect(Buffer.from(await avatar.arrayBuffer())).toEqual(avatarBytes);
      const ticketResponse = await fetch(new URL("/v1/team-auth/ticket", apiUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ serverId: "linux-team-host" }),
      });
      expect(ticketResponse.status).toBe(200);
      const ticketPayload = await ticketResponse.json();
      expect(ticketPayload).toMatchObject({ ticket: expect.any(String), expiresAt: expect.any(Number) });
      if (!isDynamicRecord(ticketPayload) || typeof ticketPayload.ticket !== "string") {
        throw new Error("Team ticket response was invalid.");
      }

      const unauthorizedRedemption = await fetch(new URL("/v1/team-auth/redeem", apiUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ ticket: ticketPayload.ticket, serverId: "linux-team-host" }),
      });
      expect(unauthorizedRedemption.status).toBe(401);

      const redemption = await fetch(new URL("/v1/team-auth/redeem", apiUrl), {
        method: "POST",
        headers: {
          // The receiving host can be signed in as its owner while this ticket belongs to an
          // invited member. A valid API session authorizes redemption; the ticket chooses the user.
          Authorization: `Bearer ${otherAccount.token}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ ticket: ticketPayload.ticket, serverId: "linux-team-host" }),
      });
      expect(await redemption.json()).toEqual({
        user: {
          id: account.id,
          email: "owner@openbot.test",
          name: profile.name,
          avatarUrl: profile.avatarUrl,
        },
      });

      const teamReplay = await fetch(new URL("/v1/team-auth/redeem", apiUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ ticket: ticketPayload.ticket, serverId: "linux-team-host" }),
      });
      expect(await teamReplay.json()).toEqual({ user: null });

      const profileResponse = await fetch(new URL("/v1/me/profile", apiUrl), {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${sessionBody.sessionToken}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ name: "Shared name" }),
      });
      expect(profileResponse.status).toBe(200);
      expect(changed).toEqual([
        { id: account.id, email: "owner@openbot.test", name: "Shared name", avatarUrl: profile.avatarUrl },
      ]);

      const removeFromAccount = await fetch(new URL("/v1/me/servers/linux-team-host", apiUrl), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${sessionToken}`, Connection: "close" },
      });
      expect(removeFromAccount.status).toBe(204);
      const afterRemove = await fetch(new URL("/v1/me/servers", apiUrl), {
        headers: { Authorization: `Bearer ${sessionToken}`, Connection: "close" },
      });
      expect(await afterRemove.json()).toEqual({ servers: [] });
      const otherAccountAfterRemove = await fetch(new URL("/v1/me/servers", apiUrl), {
        headers: { Authorization: `Bearer ${otherAccount.token}`, Connection: "close" },
      });
      expect(await otherAccountAfterRemove.json()).toMatchObject({
        servers: [{ hostId: "linux-team-host", membershipId: "other-membership" }],
      });
      const otherImportExclusions = await fetch(new URL("/v1/me/servers/legacy-import-exclusions", apiUrl), {
        headers: { Authorization: `Bearer ${otherAccount.token}`, Connection: "close" },
      });
      expect(await otherImportExclusions.json()).toEqual({ excludedHostIds: ["second-team-host"] });
      const otherRemove = await fetch(new URL("/v1/me/servers/linux-team-host", apiUrl), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${otherAccount.token}`, Connection: "close" },
      });
      expect(otherRemove.status).toBe(204);
      const importExclusionsAfterRemove = await fetch(new URL("/v1/me/servers/legacy-import-exclusions", apiUrl), {
        headers: { Authorization: `Bearer ${otherAccount.token}`, Connection: "close" },
      });
      expect(await importExclusionsAfterRemove.json()).toEqual({
        excludedHostIds: ["second-team-host", "linux-team-host"],
      });
      const staleImport = await fetch(new URL("/v1/me/servers", apiUrl), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${otherAccount.token}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({
          hostId: "linux-team-host",
          name: "Renamed host",
          apiUrl: "http://100.100.10.2:43123",
          fingerprint: remoteHostFingerprint(publicKey),
          publicKey,
          logoKey: null,
          membershipId: "other-membership",
          role: "member",
          legacyImport: true,
        }),
      });
      expect(await staleImport.json()).toEqual({ servers: [] });
      const unmarkedStaleRegistration = await fetch(new URL("/v1/me/servers", apiUrl), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${otherAccount.token}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({
          hostId: "linux-team-host",
          name: "Renamed host",
          apiUrl: "http://100.100.10.2:43123",
          fingerprint: remoteHostFingerprint(publicKey),
          publicKey,
          logoKey: null,
          membershipId: "other-membership",
          role: "member",
        }),
      });
      expect(await unmarkedStaleRegistration.json()).toEqual({ servers: [] });
      const explicitRejoin = await fetch(new URL("/v1/me/servers", apiUrl), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${otherAccount.token}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({
          hostId: "linux-team-host",
          name: "Renamed host",
          apiUrl: "http://100.100.10.2:43123",
          fingerprint: remoteHostFingerprint(publicKey),
          publicKey,
          logoKey: null,
          membershipId: "other-membership",
          role: "member",
          rejoin: true,
        }),
      });
      expect(await explicitRejoin.json()).toMatchObject({ servers: [{ hostId: "linux-team-host" }] });

      const loginResponse = await fetch(new URL("/v1/auth/login", apiUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({
          email: "OWNER@openbot.test",
          password: "central-password-123",
          deviceId: "desktop-stable-id",
          deviceName: "Main PC",
          platform: "unknown",
        }),
      });
      expect(loginResponse.status).toBe(200);
      const login = await loginResponse.json();
      expect(login).toMatchObject({ user: { id: account.id, email: "owner@openbot.test" }, localOnly: true });
      expect(login.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(await Effect.runPromise(authority.listActiveDeviceSessions())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ deviceName: "Main PC", platform: "unknown" }),
          expect.objectContaining({ deviceName: "Pixel 7a", platform: "android" }),
        ]),
      );

      const badLogin = await fetch(new URL("/v1/auth/login", apiUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({ email: "owner@openbot.test", password: "not-the-password" }),
      });
      expect(badLogin.status).toBe(401);

      const replay = await fetch(new URL("/v1/mobile-auth/redeem", apiUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({
          ticket: pair.ticket,
          hostId: "linux-team-host",
          fingerprint: "f".repeat(43),
          deviceId: "stable-device-id",
          deviceName: "Pixel 7a",
          platform: "android",
        }),
      });
      expect(replay.status).toBe(401);
    } finally {
      await api.stop();
    }
  });

  it("lists the online local owner host across devices without undoing a hide or leave", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-self-hosted-local-owner-directory-"));
    roots.push(root);
    const authority = new SelfHostedIdentityAuthority({ path: join(root, "identity.json") });
    await Effect.runPromise(authority.initialize());
    const owner = await Effect.runPromise(
      authority.registerAccount({ email: "owner@openbot.test", password: "owner-password-123", name: "Linux owner" }),
    );
    const other = await Effect.runPromise(
      authority.registerAccount({
        email: "other@openbot.test",
        password: "other-password-123",
        name: "Other account",
      }),
    );
    const directory = new SelfHostedAccountServerDirectory(join(root, "server-directory.json"));
    const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyForLocalOwnerDirectoryTest";
    const hostId = "linux-team-host";
    let registration = {
      hostId,
      name: "Linux host",
      apiUrl: "http://100.100.10.2:43123",
      fingerprint: remoteHostFingerprint(publicKey),
      publicKey,
      logoKey: null,
      membershipId: "owner-membership",
      role: "member" as const,
    };
    let hostOnline = false;
    const api = new SelfHostedIdentityApiServer({
      authority,
      serverDirectory: directory,
      isOwnerOfHost: (accountId, candidateHostId) => accountId === owner.account.id && candidateHostId === hostId,
      getLocalOwnerServerRegistration: () => (hostOnline ? registration : null),
      port: 0,
      listen: (server: Server) =>
        new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") return reject(new Error("No listener address."));
            resolve({ address: "127.0.0.1", family: 4, port: address.port });
          });
        }),
    });
    const apiUrl = await api.start();
    const readServers = async (token: string) => {
      const response = await fetch(new URL("/v1/me/servers", apiUrl), {
        headers: { Authorization: `Bearer ${token}`, Connection: "close" },
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    try {
      expect(await readServers(owner.token)).toEqual({ servers: [] });
      hostOnline = true;
      expect(await readServers(owner.token)).toMatchObject({
        servers: [{ hostId, apiUrl: registration.apiUrl, isOwner: true, role: "owner" }],
      });
      expect(await readServers(other.token)).toEqual({ servers: [] });

      registration = { ...registration, name: "Linux host after network change", apiUrl: "http://100.100.10.3:43123" };
      expect(await readServers(owner.token)).toMatchObject({
        servers: [{ hostId, name: registration.name, apiUrl: registration.apiUrl, isOwner: true, role: "owner" }],
      });

      await directory.setServerVisible(hostId, false);
      expect(await readServers(owner.token)).toEqual({ servers: [] });
      await directory.setServerVisible(hostId, true);
      await directory.removeMembership(owner.account.id, hostId);
      expect(await readServers(owner.token)).toEqual({ servers: [] });
      expect(await directory.legacyImportExclusions(owner.account.id)).toContain(hostId);
    } finally {
      await api.stop();
    }
  });

  it("keeps an orphaned hidden-host tombstone when an unrelated membership is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-self-hosted-hidden-host-tombstone-"));
    roots.push(root);
    const directory = new SelfHostedAccountServerDirectory(join(root, "server-directory.json"));
    await directory.initialize();
    const publicKey = "directory-test-public-key";
    const host = {
      hostId: "listed-host",
      name: "Listed host",
      apiUrl: "http://100.100.10.2:43123",
      fingerprint: remoteHostFingerprint(publicKey),
      publicKey,
      logoKey: null,
      membershipId: "member-id",
      role: "member" as const,
    };

    await directory.setServerVisible("hidden-local-host", false);
    await directory.register("account", host);
    await directory.removeMembership("account", host.hostId);

    expect(await directory.legacyImportExclusions("account")).toContain("hidden-local-host");
    expect(
      await directory.register("account", {
        ...host,
        hostId: "hidden-local-host",
        rejoin: true,
      }),
    ).toEqual([]);
  });

  it("merges stale directory instances before writing cross-device registrations and visibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-self-hosted-directory-processes-"));
    roots.push(root);
    const path = join(root, "server-directory.json");
    const linuxDirectory = new SelfHostedAccountServerDirectory(path);
    const windowsDirectory = new SelfHostedAccountServerDirectory(path);
    await Promise.all([linuxDirectory.initialize(), windowsDirectory.initialize()]);
    const publicKey = "directory-process-test-public-key";
    const registration = (hostId: string, name: string) => ({
      hostId,
      name,
      apiUrl: "http://100.100.10.2:43123",
      fingerprint: remoteHostFingerprint(publicKey),
      publicKey,
      logoKey: null,
      membershipId: `${hostId}-member`,
      role: "owner" as const,
    });

    await Promise.all([
      linuxDirectory.register("shared-account", registration("linux-host", "Linux")),
      windowsDirectory.register("shared-account", registration("windows-host", "Windows")),
    ]);

    expect(await linuxDirectory.list("shared-account")).toHaveLength(2);
    expect(await windowsDirectory.list("shared-account")).toHaveLength(2);

    await linuxDirectory.setServerVisible("linux-host", false);
    expect(
      await windowsDirectory.list("shared-account").then((servers) => servers.map((server) => server.hostId)),
    ).toEqual(["windows-host"]);
    await linuxDirectory.setServerVisible("linux-host", true);
    expect(await windowsDirectory.list("shared-account")).toHaveLength(2);
  });

  it("registers a separate account and keeps one-time QR credential setup tied to its stable account", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-self-hosted-identity-accounts-"));
    roots.push(root);
    const authority = new SelfHostedIdentityAuthority({ path: join(root, "identity.json") });
    await Effect.runPromise(authority.initialize());
    const owner = await Effect.runPromise(authority.ensureLocalAccount(profile));
    const pairing = await Effect.runPromise(
      authority.issueMobileConnectTicket({
        accountId: owner.id,
        hostId: "team-host",
        fingerprint: "f".repeat(43),
      }),
    );
    const mobile = await Effect.runPromise(
      authority.redeemMobileConnectTicket({
        ticket: pairing.ticket,
        hostId: "team-host",
        fingerprint: "f".repeat(43),
        deviceId: "phone-id",
        deviceName: "Pixel 7a",
        platform: "android",
      }),
    );
    if (!mobile) throw new Error("The QR ticket could not be redeemed.");

    const api = new SelfHostedIdentityApiServer({
      authority,
      serverDirectory: new SelfHostedAccountServerDirectory(join(root, "server-directory.json")),
      port: 0,
      listen: (server: Server) =>
        new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") return reject(new Error("No listener address."));
            resolve({ address: "127.0.0.1", family: 4, port: address.port });
          });
        }),
    });
    const apiUrl = await api.start();

    try {
      const setup = await fetch(new URL("/v1/me/credentials", apiUrl), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${mobile.token}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ email: "Owner@OpenBot.test", password: "owner-password-long-enough" }),
      });
      expect(setup.status).toBe(200);
      expect(await setup.json()).toMatchObject({ id: owner.id, email: "owner@openbot.test" });

      const update = await fetch(new URL("/v1/me/credentials", apiUrl), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${mobile.token}`,
          "Content-Type": "application/json",
          Connection: "close",
        },
        body: JSON.stringify({ email: "updated@OpenBot.test", password: "" }),
      });
      expect(update.status).toBe(200);
      expect(await update.json()).toMatchObject({ id: owner.id, email: "updated@openbot.test" });

      const registration = await fetch(new URL("/v1/auth/register", apiUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({
          name: "Second account",
          email: "SECOND@OpenBot.test",
          password: "second-account-password-long-enough",
          deviceId: "second-phone",
          deviceName: "Another phone",
          platform: "android",
        }),
      });
      expect(registration.status).toBe(201);
      const created = await registration.json();
      expect(created).toMatchObject({
        user: { email: "second@openbot.test", name: "Second account" },
        localOnly: true,
      });
      expect(created.user.id).not.toBe(owner.id);

      const duplicate = await fetch(new URL("/v1/auth/register", apiUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({
          name: "Duplicate",
          email: "second@openbot.test",
          password: "second-account-password-long-enough",
        }),
      });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({ error: "email_taken" });

      const secondAvatar = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
      const avatarUpdate = await fetch(new URL("/v1/me/avatar", apiUrl), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${created.sessionToken}`,
          "Content-Type": "image/png",
          Connection: "close",
        },
        body: secondAvatar,
      });
      expect(avatarUpdate.status).toBe(200);
      const avatarUser = await avatarUpdate.json();
      expect(selfHostedTeamProfile(avatarUser, "http://100.100.10.2:43124").avatarUrl).toBe(
        `http://100.100.10.2:43124/v1/profile/avatar?account=${created.user.id}`,
      );
      const avatar = await fetch(new URL(`/v1/profile/avatar?account=${created.user.id}`, apiUrl));
      expect(avatar.status).toBe(200);
      expect(Buffer.from(await avatar.arrayBuffer())).toEqual(secondAvatar);
      const ownerAvatar = await fetch(new URL(`/v1/profile/avatar?account=${owner.id}`, apiUrl));
      expect(Buffer.from(await ownerAvatar.arrayBuffer())).toEqual(avatarBytes);
    } finally {
      await api.stop();
    }
  });
});
