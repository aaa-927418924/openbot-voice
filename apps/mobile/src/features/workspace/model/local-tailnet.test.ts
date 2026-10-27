// @vitest-environment node
import { createOpenBotInviteUrl } from "@openbot/contracts/invite-links";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import { createEd25519Identity, signEd25519 } from "@openbot/team-client/ed25519";
import { remoteHostFingerprint } from "@openbot/team-client/remote-directory";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DirectTailnetTeamClient,
  type LocalTailnetSocketDiagnostic,
  pairTailnetInvite,
  parseTailnetInvite,
  previewTailnetInvite,
} from "./local-tailnet";

const serverId = "00000000-0000-4000-8000-0000000000a1";
const apiUrl = "http://100.100.10.2:43123/";
const randomBytes = (size: number) => new Uint8Array(size).fill(7);

class FakeTailnetSocket extends EventTarget {
  static instance: FakeTailnetSocket | null = null;
  readyState = 0;
  protocol = "";

  constructor(_url: string | URL, _protocols?: string | string[]) {
    super();
    FakeTailnetSocket.instance = this;
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = 3;
  }

  closeBeforeOpen(code: number, wasClean: boolean): void {
    this.readyState = 3;
    const event = new Event("close");
    Object.defineProperties(event, { code: { value: code }, wasClean: { value: wasClean } });
    this.dispatchEvent(event);
  }
}

afterEach(() => vi.unstubAllGlobals());

function inviteUrl(fingerprint: string): string {
  return createOpenBotInviteUrl(
    { apiUrl, serverId, fingerprint, token: "b".repeat(43) },
    { allowTailscaleApiUrl: true },
  );
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function createHostFetch() {
  const hostIdentity = await Effect.runPromise(createEd25519Identity(() => new Uint8Array(32).fill(19)));
  const publicKeyPem = hostIdentity.publicKeyPem;
  const fingerprint = remoteHostFingerprint(publicKeyPem);
  const codec = teamHttpCodec(6);
  const calls: Array<{ path: string; body: unknown; headers: Headers }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    calls.push({ path: url.pathname, body, headers });
    if (url.pathname === TEAM_API_ROUTES.compatibility)
      return Response.json({ appVersion: "0.30.0", protocol: { minimum: 1, maximum: 6 }, capabilities: [] });
    if (url.pathname === TEAM_API_ROUTES.identity) {
      const challenge = url.searchParams.get("challenge") ?? "";
      const identity = {
        serverId,
        publicKey: publicKeyPem,
        serverName: "Tailnet host",
        fingerprint,
        enabledOnLaunch: true,
        challenge,
        signature: toBase64Url(
          await Effect.runPromise(signEd25519(new TextEncoder().encode(challenge), hostIdentity.secretKey)),
        ),
        logoVersion: null,
      };
      return Response.json(JSON.parse(codec.encodeResponse("GET", url.pathname, 200, identity, {})));
    }
    if (url.pathname === TEAM_API_ROUTES.join.invitationPreview) {
      const preview = { role: "member", expiresAt: new Date(Date.now() + 60_000).toISOString(), emailBound: false };
      return Response.json(JSON.parse(codec.encodeResponse("POST", url.pathname, 200, preview, {})));
    }
    if (url.pathname === TEAM_API_ROUTES.join.server) {
      const joined = {
        member: {
          id: "member-id",
          username: "device-test",
          email: null,
          name: null,
          avatarUrl: null,
          role: "member",
          createdAt: new Date().toISOString(),
          disabled: false,
        },
        sessionToken: "local-session-token",
        sessionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
      return Response.json(JSON.parse(codec.encodeResponse("POST", url.pathname, 201, joined, {})), { status: 201 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  return { fingerprint, fetcher, calls };
}

describe("Android direct Tailscale pairing", () => {
  it("accepts only Tailscale API addresses in local mode", () => {
    expect(parseTailnetInvite(inviteUrl("a".repeat(43))).apiUrl).toBe(apiUrl);
    const publicInvite = createOpenBotInviteUrl({
      apiUrl: "https://api.openbot.run/",
      serverId,
      fingerprint: "a".repeat(43),
      token: "b".repeat(43),
    });
    expect(() => parseTailnetInvite(publicInvite)).toThrow("Tailscale host invitations");
  });

  it("reviews and joins a host after verifying its signed identity without an account request", async () => {
    const host = await createHostFetch();
    const link = inviteUrl(host.fingerprint);
    await expect(
      previewTailnetInvite(link, { appVersion: "1.1.0", fetch: host.fetcher, randomBytes }),
    ).resolves.toMatchObject({
      hostId: serverId,
      hostName: "Tailnet host",
      role: "member",
      devicePublicKey: expect.stringContaining("BEGIN PUBLIC KEY"),
    });
    await expect(
      pairTailnetInvite(link, { appVersion: "1.1.0", fetch: host.fetcher, randomBytes }),
    ).resolves.toMatchObject({
      hostId: serverId,
      name: "Tailnet host",
      apiUrl,
      sessionToken: "local-session-token",
      membershipId: "member-id",
      role: "member",
    });
    expect(host.calls.filter((call) => call.path === TEAM_API_ROUTES.join.server)).toHaveLength(1);
    expect(host.calls.every((call) => !call.headers.has("Authorization"))).toBe(true);
    for (const call of host.calls.filter((entry) => entry.path !== TEAM_API_ROUTES.compatibility)) {
      expect(call.headers.get(TEAM_APP_VERSION_HEADER)).toBe("1.1.0");
      expect(call.headers.get(TEAM_PROTOCOL_VERSION_HEADER)).toBe("6");
      expect(call.headers.get(TEAM_CAPABILITIES_HEADER)).toBeTruthy();
    }
  });

  it("does not send the invite token when the host identity does not match the link", async () => {
    const host = await createHostFetch();
    await expect(
      pairTailnetInvite(inviteUrl("a".repeat(43)), { appVersion: "1.1.0", fetch: host.fetcher, randomBytes }),
    ).rejects.toThrow("identity could not be verified");
    expect(host.calls.some((call) => call.path === TEAM_API_ROUTES.join.server)).toBe(false);
  });

  it("rejects an event socket that closes before opening and records safe connection details", async () => {
    vi.stubGlobal("WebSocket", FakeTailnetSocket);
    const sessionToken = "private-session-token";
    const client = new DirectTailnetTeamClient(
      {
        hostId: serverId,
        name: "Tailnet host",
        logoKey: null,
        apiUrl,
        publicKey: "unused",
        fingerprint: "unused",
        sessionToken,
        membershipId: "member-id",
        role: "member",
      },
      { randomBytes },
    );
    const diagnostics: LocalTailnetSocketDiagnostic[] = [];
    const onClosed = vi.fn();
    const opening = client.openEvents(
      () => {},
      onClosed,
      (entry) => diagnostics.push(entry),
    );

    FakeTailnetSocket.instance?.closeBeforeOpen(1006, false);

    await expect(opening).rejects.toThrow("event connection failed");
    expect(diagnostics.map(({ phase }) => phase)).toEqual(["opening", "close"]);
    expect(diagnostics[1]).toMatchObject({
      phase: "close",
      readyState: 3,
      protocolAccepted: false,
      code: 1006,
      wasClean: false,
    });
    expect(onClosed).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostics)).not.toContain(sessionToken);
  });
});
