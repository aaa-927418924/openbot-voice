// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
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
      expect(await ticketResponse.json()).toMatchObject({ ticket: expect.any(String), expiresAt: expect.any(Number) });

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
          Authorization: "Bearer " + mobile.token,
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
