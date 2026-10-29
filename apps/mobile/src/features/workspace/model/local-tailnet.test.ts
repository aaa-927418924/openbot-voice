// @vitest-environment node
import { createOpenBotInviteUrl } from "@openbot/contracts/invite-links";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { CHANNEL_ROUTES } from "@openbot/contracts/team-protocol/channels-v1";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import {
  TEAM_MEMBER_DEVICE_LINK_CAPABILITY,
  TEAM_MEMBER_DEVICE_LINK_ROUTES,
} from "@openbot/contracts/team-protocol/member-device-link-v1";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import {
  decodeTeamProtocolSupportV1,
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import { createEd25519Identity, signEd25519 } from "@openbot/team-client/ed25519";
import { remoteHostFingerprint } from "@openbot/team-client/remote-directory";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTailnetMemberDeviceLinkUrl,
  DirectTailnetTeamClient,
  decodeTailnetMemberDeviceLink,
  isTailnetMemberDeviceLink,
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
  static constructedUrl: string | null = null;
  readyState = 0;
  protocol = "";

  constructor(url: string, _protocols?: string | string[]) {
    super();
    FakeTailnetSocket.constructedUrl = url;
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
      return Response.json({
        appVersion: "0.30.0",
        protocol: { minimum: 1, maximum: 6 },
        capabilities: [TEAM_MEMBER_DEVICE_LINK_CAPABILITY],
      });
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
    if (url.pathname === CHANNEL_ROUTES.list) {
      const sideRoute = teamSideRouteCodec(url.pathname);
      if (!sideRoute) throw new Error("Channel route codec is unavailable.");
      return Response.json(sideRoute.response(url.pathname, 200, []));
    }
    if (url.pathname === TEAM_API_ROUTES.agent.avatar("agent-1"))
      return new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), {
        headers: { "Content-Type": "image/png" },
      });
    if (url.pathname === TEAM_API_ROUTES.attachment("video-1")) {
      const range = url.searchParams.has("offset");
      return new Response(Uint8Array.from([0, 0, 0, range ? 2 : 1, 102, 116, 121, 112]), {
        status: range ? 206 : 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": "attachment; filename*=UTF-8''%E6%97%85%E8%A1%8C%E3%83%93%E3%83%87%E3%82%AA.mp4",
        },
      });
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
    if (url.pathname === TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem) {
      const sideRoute = teamSideRouteCodec(url.pathname);
      if (!sideRoute) throw new Error("Member device link route codec is unavailable.");
      const joined = {
        member: { id: "same-member-id", role: "owner" },
        sessionToken: "same-member-session-token",
        sessionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
      return Response.json(sideRoute.response(url.pathname, 201, joined), { status: 201 });
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
      pairTailnetInvite(link, { appVersion: "1.1.0", fetch: host.fetcher, randomBytes, displayName: "あああ" }),
    ).resolves.toMatchObject({
      hostId: serverId,
      name: "Tailnet host",
      apiUrl,
      sessionToken: "local-session-token",
      membershipId: "member-id",
      role: "member",
    });
    expect(host.calls.filter((call) => call.path === TEAM_API_ROUTES.join.server)).toHaveLength(1);
    expect(host.calls.find((call) => call.path === TEAM_API_ROUTES.join.server)?.body).toMatchObject({
      displayName: "あああ",
    });
    expect(host.calls.every((call) => !call.headers.has("Authorization"))).toBe(true);
    for (const call of host.calls.filter((entry) => entry.path !== TEAM_API_ROUTES.compatibility)) {
      expect(call.headers.get(TEAM_APP_VERSION_HEADER)).toBe("1.1.0");
      expect(call.headers.get(TEAM_PROTOCOL_VERSION_HEADER)).toBe("6");
      expect(call.headers.get(TEAM_CAPABILITIES_HEADER)).toBeTruthy();
    }
  });

  it("verifies and redeems a separate device link into the same member identity", async () => {
    const host = await createHostFetch();
    const server = {
      hostId: serverId,
      name: "Tailnet host",
      logoKey: null,
      apiUrl,
      publicKey: "unused",
      fingerprint: host.fingerprint,
      sessionToken: "current-session-token",
      membershipId: "same-member-id",
      role: "owner" as const,
    };
    const deviceLink = createTailnetMemberDeviceLinkUrl(server, "c".repeat(43));
    expect(isTailnetMemberDeviceLink(deviceLink)).toBe(true);

    await expect(
      previewTailnetInvite(deviceLink, { appVersion: "1.1.0", fetch: host.fetcher, randomBytes }),
    ).resolves.toMatchObject({ hostId: serverId, hostName: "Tailnet host" });
    await expect(
      pairTailnetInvite(deviceLink, {
        appVersion: "1.1.0",
        fetch: host.fetcher,
        randomBytes,
        existingSessionToken: server.sessionToken,
      }),
    ).resolves.toMatchObject({
      hostId: serverId,
      membershipId: "same-member-id",
      sessionToken: "same-member-session-token",
      role: "owner",
    });
    expect(host.calls.filter((call) => call.path === TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem)).toHaveLength(1);
    expect(host.calls.some((call) => call.path === TEAM_API_ROUTES.join.server)).toBe(false);
    expect(host.calls.find((call) => call.path === TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem)?.body).toEqual({
      token: "c".repeat(43),
    });
    expect(
      host.calls.find((call) => call.path === TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem)?.headers.get("Authorization"),
    ).toBe(`Bearer ${server.sessionToken}`);
    expect(decodeTailnetMemberDeviceLink({ token: "d".repeat(43), expiresAt: new Date().toISOString() }).token).toBe(
      "d".repeat(43),
    );
  });

  it("does not send the invite token when the host identity does not match the link", async () => {
    const host = await createHostFetch();
    await expect(
      pairTailnetInvite(inviteUrl("a".repeat(43)), { appVersion: "1.1.0", fetch: host.fetcher, randomBytes }),
    ).rejects.toThrow("identity could not be verified");
    expect(host.calls.some((call) => call.path === TEAM_API_ROUTES.join.server)).toBe(false);
  });

  it("sends direct Tailnet GET requests without a JSON body or content type", async () => {
    const host = await createHostFetch();
    const client = new DirectTailnetTeamClient(
      {
        hostId: serverId,
        name: "Tailnet host",
        logoKey: null,
        apiUrl,
        publicKey: "unused",
        fingerprint: host.fingerprint,
        sessionToken: "local-session-token",
        membershipId: "member-id",
        role: "member",
      },
      { appVersion: "1.1.0", fetch: host.fetcher, randomBytes },
    );

    await client.connect();
    await expect(
      client.request("GET", TEAM_API_ROUTES.compatibility, decodeTeamProtocolSupportV1),
    ).resolves.toMatchObject({ protocol: { minimum: 1, maximum: 6 } });
    await expect(client.request("GET", CHANNEL_ROUTES.list, (value) => value)).resolves.toEqual([]);
    await expect(
      client.request("GET", TEAM_API_ROUTES.agent.avatar("agent-1"), (value) => {
        if (typeof value !== "object" || value === null || !("mimeType" in value) || !("base64" in value))
          throw new Error("Invalid avatar response.");
        return `data:${value.mimeType};base64,${value.base64}`;
      }),
    ).resolves.toBe("data:image/png;base64,iVBORw0KGgo=");

    const decodeFile = (value: unknown) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("name" in value) ||
        !("mimeType" in value) ||
        !("base64" in value)
      )
        throw new Error("Invalid attachment response.");
      return value;
    };
    await expect(client.request("GET", TEAM_API_ROUTES.attachment("video-1"), decodeFile)).resolves.toMatchObject({
      name: "旅行ビデオ.mp4",
      mimeType: "video/mp4",
      base64: "AAAAAWZ0eXA=",
    });
    await expect(
      client.request("GET", `${TEAM_API_ROUTES.attachment("video-1")}?offset=0&length=4`, decodeFile),
    ).resolves.toMatchObject({
      name: "旅行ビデオ.mp4",
      mimeType: "video/mp4",
      base64: "AAAAAmZ0eXA=",
    });

    const compatibilityRequests = host.calls.filter((call) => call.path === TEAM_API_ROUTES.compatibility);
    expect(compatibilityRequests).toHaveLength(2);
    expect(compatibilityRequests.every((call) => call.body === undefined)).toBe(true);
    expect(compatibilityRequests.every((call) => call.headers.get("Content-Type") === null)).toBe(true);
  });

  it("rejects an event socket that closes before opening and records safe connection details", async () => {
    vi.stubGlobal("WebSocket", FakeTailnetSocket);
    FakeTailnetSocket.constructedUrl = null;
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

    expect(FakeTailnetSocket.constructedUrl).toBe("ws://100.100.10.2:43123/v1/events");
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
