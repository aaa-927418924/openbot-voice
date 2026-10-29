// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SelfHostedIdentityApiServer, selfHostedTeamProfile } from "./self-hosted-identity-api";
import { SelfHostedIdentityAuthority } from "./self-hosted-identity-authority";

const roots: string[] = [];
const avatarBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const profile = {
  id: "local-owner-id",
  name: "Linux owner",
  avatarUrl: `data:image/png;base64,${avatarBytes.toString("base64")}`,
};
const redeemedSessionSchema = z.object({
  sessionToken: z.string(),
  user: z.object({ id: z.string(), email: z.string() }),
  localOnly: z.boolean(),
});

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
      const sessionBody = redeemedSessionSchema.parse(await redeem.json());
      expect(sessionBody).toMatchObject({
        sessionToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        user: { id: account.id, email: "" },
        localOnly: true,
      });
      expect(
        selfHostedTeamProfile(
          { id: account.id, email: "", name: account.name, avatarUrl: account.avatarUrl },
          "http://100.100.10.2:43124",
        ).avatarUrl,
      ).toBe("http://100.100.10.2:43124/v1/profile/avatar");
      const avatar = await fetch(new URL("/v1/profile/avatar", apiUrl));
      expect(avatar.status).toBe(200);
      expect(avatar.headers.get("Content-Type")).toBe("image/png");
      expect(Buffer.from(await avatar.arrayBuffer())).toEqual(avatarBytes);
      const ticketResponse = await fetch(new URL("/v1/team-auth/ticket", apiUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionBody.sessionToken}`,
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
      expect(changed).toEqual([{ id: account.id, email: "", name: "Shared name", avatarUrl: profile.avatarUrl }]);

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
});
