import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemberDeviceLinkUrl } from "@openbot/contracts/invite-links";
import { parseMobileConnectUrl } from "@openbot/contracts/mobile-connect";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { createHostedMobileConnect, createSelfHostedMobileConnect } from "./mobile-connect-host";
import { SelfHostedIdentityAuthority } from "./self-hosted-identity-authority";

const binding = { hostId: "11111111-1111-4111-8111-111111111111", fingerprint: "a".repeat(43) };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createSelfHostedMobileConnect", () => {
  it("starts the local Team and identity APIs before issuing a fingerprint-bound QR ticket", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-self-hosted-mobile-connect-"));
    roots.push(root);
    const authority = new SelfHostedIdentityAuthority({ path: join(root, "identity.json") });
    await Effect.runPromise(authority.initialize());
    const account = await Effect.runPromise(
      authority.ensureLocalAccount({ id: "owner-id", name: "Linux owner", avatarUrl: null }),
    );
    const operations: string[] = [];

    const qr = await runCauseEffect(
      createSelfHostedMobileConnect({
        authority,
        identityApi: {
          start: async () => {
            operations.push("identity-api");
            return "http://100.100.10.2:43124";
          },
        },
        accountId: account.id,
        host: {
          getMobileConnectHost: () => binding,
          getStatus: () => ({ configured: true }),
          configure: () => Effect.sync(() => ({ configured: true })),
          start: () =>
            Effect.sync(() => {
              operations.push("team-api");
              return {
                serverId: binding.hostId,
                apiOnline: true,
                apiUrl: "http://100.100.10.2:43123",
                message: null,
                phase: "online" as const,
              };
            }),
          createMemberDeviceLink: () =>
            Effect.sync(() => {
              operations.push("member-link");
              return createMemberDeviceLinkUrl({
                apiUrl: "http://100.100.10.2:43123",
                serverId: binding.hostId,
                fingerprint: binding.fingerprint,
                token: "d".repeat(43),
              });
            }),
        },
      }),
    );

    const payload = parseMobileConnectUrl(qr.qrData);
    expect(operations).toEqual(["team-api", "member-link", "identity-api"]);
    expect(payload).toMatchObject({
      apiUrl: "http://100.100.10.2:43124",
      host: binding,
      memberDeviceLink: expect.stringContaining("device="),
    });
    expect(qr.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("createHostedMobileConnect", () => {
  it("creates and starts a local server before issuing the pairing code", async () => {
    const operations: string[] = [];
    const ticket = { qrData: "openbot://mobile-connect?ticket=test", expiresAt: Date.now() + 60_000 };

    await expect(
      runCauseEffect(
        createHostedMobileConnect({
          centralAuth: {
            createMobileConnect: (host) =>
              Effect.sync(() => {
                expect(host).toEqual(binding);
                operations.push("ticket");
                return ticket;
              }),
          },
          host: {
            getMobileConnectHost: () => binding,
            getStatus: () => ({ configured: false }),
            configure: () =>
              Effect.sync(() => {
                operations.push("configure");
                return { configured: true };
              }),
            start: () =>
              Effect.sync(() => {
                operations.push("start");
                return {
                  serverId: binding.hostId,
                  apiOnline: true,
                  apiUrl: "wss://signal.openbot.run/v1/signal",
                  message: null,
                  phase: "online" as const,
                };
              }),
          },
        }),
      ),
    ).resolves.toEqual(ticket);
    expect(operations).toEqual(["configure", "start", "ticket"]);
  });

  it("preserves the existing server identity", async () => {
    const operations: string[] = [];

    await Effect.runPromise(
      createHostedMobileConnect({
        centralAuth: {
          createMobileConnect: () =>
            Effect.sync(() => {
              operations.push("ticket");
              return { qrData: "openbot://mobile-connect?ticket=test", expiresAt: Date.now() + 60_000 };
            }),
        },
        host: {
          getMobileConnectHost: () => binding,
          getStatus: () => ({ configured: true }),
          configure: () =>
            Effect.sync(() => {
              operations.push("configure");
              return { configured: true };
            }),
          start: () =>
            Effect.sync(() => {
              operations.push("start");
              return {
                serverId: binding.hostId,
                apiOnline: true,
                apiUrl: "wss://signal.openbot.run/v1/signal",
                message: null,
                phase: "online" as const,
              };
            }),
        },
      }),
    );

    expect(operations).toEqual(["start", "ticket"]);
  });

  it("does not issue a pairing code while only the local development API is online", async () => {
    const createMobileConnect = vi.fn();

    await expect(
      runCauseEffect(
        createHostedMobileConnect({
          centralAuth: { createMobileConnect },
          host: {
            getMobileConnectHost: () => binding,
            getStatus: () => ({ configured: true }),
            configure: () => Effect.sync(() => ({ configured: true })),
            start: () =>
              Effect.sync(() => ({
                serverId: binding.hostId,
                apiOnline: true,
                apiUrl: "http://localhost:49231",
                message: "Local development host is ready.",
                phase: "online" as const,
              })),
          },
        }),
      ),
    ).rejects.toThrow("Local development host is ready.");
    expect(createMobileConnect).not.toHaveBeenCalled();
  });
});
