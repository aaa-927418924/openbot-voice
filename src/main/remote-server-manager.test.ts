import { Effect } from "effect";
import { authCall, CentralAuthOperationError } from "./central-auth-effects";
import { RemoteWorkflowError, remoteCall } from "./remote-service-effects";
// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccountServerDirectoryEntry,
  AccountServerRegistration,
} from "@openbot/contracts/account-server-directory";
import { createMemberDeviceLinkUrl, parseMemberDeviceLinkUrl } from "@openbot/contracts/invite-links";
import { LOCAL_SERVER_ID, type RemoteDesktopSession } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import {
  TEAM_MEMBER_DEVICE_LINK_CAPABILITY,
  TEAM_MEMBER_DEVICE_LINK_ROUTES,
} from "@openbot/contracts/team-protocol/member-device-link-v1";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { decodeBrowserPreviewFromHost, decodeBrowserTab } from "./remote-device-decoding";
import { REMOTE_DESKTOP_SESSION_START_TIMEOUT_MS, RemoteServerManager } from "./remote-server-manager";
import {
  createRemoteManager,
  deferredRoute,
  fakeWebRtcTransport,
  stopRemoteFixtures,
  storedHttpsServer,
  stubEventSockets,
  stubTeamFetch,
  waitForServer,
} from "./remote-server-test-harness";
import { remoteAttachmentPreviewUrl } from "./remote-server-urls";
import { fingerprint } from "./team-store";
import { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcClientTransport, TeamWebRtcRequestError } from "./team-webrtc-client-transport";

afterEach(async () => {
  await stopRemoteFixtures();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("remote browser responses", () => {
  it("decodes an opened browser tab", () => {
    expect(
      decodeBrowserTab({
        id: "tab-1",
        title: "Example",
        url: "https://example.com/",
        loading: false,
        ownerThreadId: "thread-1",
        ownerAgentId: "bot-1",
      }),
    ).toMatchObject({ id: "tab-1", url: "https://example.com/" });
    expect(() => decodeBrowserTab(undefined)).toThrowError("Invalid remote browser tab.");
  });

  it("accepts only bounded JPEG browser previews", () => {
    expect(
      decodeBrowserPreviewFromHost({
        dataUrl: "data:image/jpeg;base64,YWJj",
        width: 960,
        height: 600,
      }),
    ).toMatchObject({ width: 960, height: 600 });
    expect(() =>
      decodeBrowserPreviewFromHost({
        dataUrl: "data:image/png;base64,YWJj",
        width: 960,
        height: 600,
      }),
    ).toThrowError("Invalid remote browser preview.");
  });
});

describe("remote desktop session startup", () => {
  it("allows a cold host time to start its screen-capture runtime", async () => {
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("viewer-host")] });
    const session: RemoteDesktopSession = {
      id: "session-1",
      serverId: "viewer-host",
      viewerUrl: "http://127.0.0.1:8080",
      viewerGrant: "viewer-grant",
      displays: [],
      selectedDisplayId: null,
      phase: "starting_host",
      transport: "unknown",
      errorCode: null,
      message: null,
      createdAt: "2026-10-28T00:00:00.000Z",
      grantExpiresAt: "2026-10-28T00:03:00.000Z",
    };
    const request = vi.spyOn(fixture.manager, "request").mockReturnValue(Effect.succeed(session));

    await expect(runCauseEffect(fixture.manager.createRemoteDesktopSession("viewer-host"))).resolves.toEqual(session);

    expect(request).toHaveBeenCalledWith("viewer-host", TEAM_API_ROUTES.remoteScreen.sessions, expect.any(Function), {
      method: "POST",
      body: {},
      timeoutMs: REMOTE_DESKTOP_SESSION_START_TIMEOUT_MS,
    });
    expect(REMOTE_DESKTOP_SESSION_START_TIMEOUT_MS).toBe(180_000);
  });

  it("uses one cold-start deadline for compatibility negotiation and session creation", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const session: RemoteDesktopSession = {
      id: "session-1",
      serverId: "viewer-host",
      viewerUrl: "http://127.0.0.1:8080",
      viewerGrant: "viewer-grant",
      displays: [],
      selectedDisplayId: null,
      phase: "starting_host",
      transport: "unknown",
      errorCode: null,
      message: null,
      createdAt: "2026-10-28T00:00:00.000Z",
      grantExpiresAt: "2026-10-28T00:03:00.000Z",
    };
    const stub = stubTeamFetch({
      compatibility: {
        appVersion: "0.4.0",
        protocol: { minimum: 1, maximum: 6 },
        capabilities: [],
      },
      routes: { [TEAM_API_ROUTES.remoteScreen.sessions]: () => Response.json(session) },
    });
    const fixture = await createRemoteManager({
      servers: [storedHttpsServer("viewer-host")],
      appVersion: "0.4.0",
    });

    try {
      await expect(runCauseEffect(fixture.manager.createRemoteDesktopSession("viewer-host"))).resolves.toEqual(session);

      expect(stub.requests(TEAM_API_ROUTES.compatibility)).toHaveLength(1);
      expect(stub.requests(TEAM_API_ROUTES.remoteScreen.sessions)).toHaveLength(1);
      expect(timeout.mock.calls[0]?.[0]).toBe(REMOTE_DESKTOP_SESSION_START_TIMEOUT_MS);
      expect(timeout.mock.calls[1]?.[0]).toBeGreaterThan(0);
      expect(timeout.mock.calls[1]?.[0]).toBeLessThan(REMOTE_DESKTOP_SESSION_START_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("remote server links", () => {
  it("creates a pinned Tailscale member-device link only when the host advertises the route", async () => {
    const hostId = "00000000-0000-4000-8000-000000000000";
    const stub = stubTeamFetch({
      compatibility: {
        appVersion: "1.1.0",
        protocol: { minimum: 1, maximum: 6 },
        capabilities: [TEAM_MEMBER_DEVICE_LINK_CAPABILITY],
      },
      routes: {
        [TEAM_MEMBER_DEVICE_LINK_ROUTES.create]: () =>
          Response.json({ token: "d".repeat(43), expiresAt: "2026-10-29T12:10:00.000Z" }, { status: 201 }),
      },
    });
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl: "http://100.100.135.107:43123/",
          fingerprint: "a".repeat(43),
          role: "owner",
        }),
      ],
      appVersion: "1.1.0",
      managerOptions: { allowTailscaleApiUrl: true, localOnlyNetworking: true },
    });

    const url = await runCauseEffect(fixture.manager.createMemberDeviceLink(hostId));
    expect(parseMemberDeviceLinkUrl(url, { allowTailscaleApiUrl: true })).toMatchObject({
      apiUrl: "http://100.100.135.107:43123/",
      serverId: hostId,
      token: "d".repeat(43),
    });
    expect(stub.requests(TEAM_MEMBER_DEVICE_LINK_ROUTES.create)).toHaveLength(1);
    expect(stub.requests(TEAM_MEMBER_DEVICE_LINK_ROUTES.create)[0]?.headers.get("authorization")).toBe(
      `Bearer token-${hostId}`,
    );
  });

  it("creates token-free preview URLs", () => {
    const preview = remoteAttachmentPreviewUrl("00000000-0000-4000-8000-000000000000", "draft 1");
    expect(preview).toBe("openbot-remote-attachment://00000000-0000-4000-8000-000000000000/draft%201");
    expect(preview).not.toContain("token");
  });

  it("registers a member-device link redemption as an account rejoin", async () => {
    const serverId = "11111111-1111-4111-8111-111111111111";
    const apiUrl = "http://100.100.100.107:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    const stub = stubTeamFetch({
      compatibility: {
        appVersion: "1.1.0",
        protocol: { minimum: 1, maximum: 6 },
        capabilities: [TEAM_MEMBER_DEVICE_LINK_CAPABILITY],
      },
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId,
            publicKey: publicKeyPem,
            serverName: "Capability Host",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        [TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem]: () =>
          Response.json({
            member: { id: "member-id", role: "member" },
            sessionToken: "session-token",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        "/v1/remote-screen/capabilities": () =>
          Response.json({ error: "Remote control is unavailable.", code: "host_unavailable" }, { status: 503 }),
      },
    });
    const registerAccountServer = vi.fn(() => authCall(async () => []));
    const fixture = await createRemoteManager({
      servers: [],
      appVersion: "1.1.0",
      account: {
        getAccountId: () => "member-account",
        isSelfHostedSignedIn: () => true,
        registerAccountServer,
      },
      managerOptions: { allowTailscaleApiUrl: true, localOnlyNetworking: true },
    });
    class ClosedWebSocket extends EventTarget {
      close(): void {
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", ClosedWebSocket);
    const inviteUrl = createMemberDeviceLinkUrl(
      { apiUrl, serverId, fingerprint: hostFingerprint, token: "d".repeat(43) },
      { allowTailscaleApiUrl: true },
    );

    await expect(runCauseEffect(fixture.manager.join({ inviteUrl }))).resolves.toMatchObject({ id: serverId });

    expect(registerAccountServer).toHaveBeenCalledWith({
      hostId: serverId,
      name: "Capability Host",
      apiUrl,
      fingerprint: hostFingerprint,
      publicKey: publicKeyPem,
      logoKey: null,
      membershipId: "member-id",
      role: "member",
      rejoin: true,
    });
    expect(stub.requests(TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem)).toHaveLength(1);
  });

  it("keeps a pending rejoin host away from another account's legacy import", async () => {
    const hostId = "22222222-2222-4222-8222-222222222222";
    const registerAccountServer = vi.fn(() => authCall(async () => []));
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl: "http://100.100.100.107:43123/",
          accountId: "account-a",
          pendingAccountRejoinId: "account-a",
          membershipId: "member-from-account-a",
        }),
      ],
      account: {
        getAccountId: () => "account-b",
        isSelfHostedSignedIn: () => true,
        listAccountServers: () => authCall(async () => []),
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        registerAccountServer,
      },
      managerOptions: { allowTailscaleApiUrl: true, localOnlyNetworking: true },
    });
    const login = vi.spyOn(fixture.manager, "login");

    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(login).not.toHaveBeenCalled();
    expect(registerAccountServer).not.toHaveBeenCalled();
    expect(fixture.manager.list().map((server) => server.id)).not.toContain(hostId);
    expect(await readFile(fixture.statePath, "utf8")).toContain("pendingAccountRejoinId");
  });

  it("rejects a WebRTC invitation whose pinned host key does not match the control plane", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-invite-key-"));
    const statePath = join(directory, "servers.json");
    const hostId = "00000000-0000-4000-8000-000000000000";
    const acceptInvite = vi.fn();
    const bridge = new TeamWebRtcBridge();
    vi.spyOn(bridge, "disconnect").mockReturnValue(Effect.void);
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: () => authCall(async () => []),
      startSession: () => authCall(async () => ({ sessionId: "session-1", hostId, expiresAt: Date.now() + 60_000 })),
      issueTicket: () =>
        authCall(async () => ({
          ticket: "ticket",
          expiresAt: Date.now() + 60_000,
          signalUrl: "wss://signal.openbot.run/v1/signal",
        })),
      endSession: () => authCall(async () => undefined),
      createInvite: () =>
        authCall(async () => ({
          inviteId: "invite-1",
          token: "t".repeat(43),
          expiresAt: Date.now() + 60_000,
          permanent: false,
          useCount: 0,
        })),
      listInvites: () => authCall(async () => []),
      previewInvite: () =>
        authCall(async () => ({
          inviteId: "invite-1",
          hostId,
          hostName: "Studio Mac",
          role: "member" as const,
          expiresAt: Date.now() + 60_000,
          emailBound: false,
          permanent: false,
          devicePublicKey: "trusted-host-public-key",
        })),
      acceptInvite,
      revokeInvite: () => authCall(async () => undefined),
      listMembers: () => authCall(async () => []),
      updateMember: () => authCall(async () => undefined),
      removeMember: () => authCall(async () => undefined),
      getPrincipalId: () => "person-1",
      controlPlaneUrl: "https://api.openbot.run",
      downloadHostLogo: () => authCall(async () => ({ bytes: new Uint8Array(), mimeType: "image/png" })),
      transferDirectory: join(directory, "transfers"),
    });
    const manager = new RemoteServerManager(
      statePath,
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      { createTeamAuthTicket: () => authCall(async () => "ticket"), getEmail: () => "person@example.com" },
      { webrtcTransport: transport },
    );
    const inviteUrl = new URL("https://openbot.run/join");
    inviteUrl.searchParams.set("api", "https://api.openbot.run");
    inviteUrl.searchParams.set("server", hostId);
    inviteUrl.searchParams.set("fingerprint", fingerprint("attacker-public-key"));
    inviteUrl.searchParams.set("invite", "b".repeat(43));
    try {
      await runCauseEffect(manager.initialize());
      await expect(runCauseEffect(manager.join({ inviteUrl: inviteUrl.toString() }))).rejects.toThrow("identity");
      expect(acceptInvite).not.toHaveBeenCalled();
    } finally {
      await runCauseEffect(manager.stop());
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not send the token of another service's invitation to a self-hosted service", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-self-hosted-invite-"));
    const transport = fakeWebRtcTransport();
    const previewInvite = vi.spyOn(transport, "previewInvite");
    const acceptInvite = vi.spyOn(transport, "acceptInvite");
    const manager = new RemoteServerManager(
      join(directory, "servers.json"),
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      { createTeamAuthTicket: () => authCall(async () => "ticket"), getEmail: () => "person@example.com" },
      { webrtcTransport: transport, selfHostedApiOrigin: "https://api.example.com" },
    );
    const inviteUrl = new URL("https://openbot.run/join");
    inviteUrl.searchParams.set("api", "https://api.openbot.run/");
    inviteUrl.searchParams.set("server", "00000000-0000-4000-8000-000000000000");
    inviteUrl.searchParams.set("fingerprint", "a".repeat(43));
    inviteUrl.searchParams.set("invite", "b".repeat(43));
    try {
      await runCauseEffect(manager.initialize());
      const input = { inviteUrl: inviteUrl.toString() };
      await expect(runCauseEffect(manager.previewInvite(input))).rejects.toThrow("another OpenBot service");
      await expect(runCauseEffect(manager.join(input))).rejects.toThrow("another OpenBot service");
      expect(previewInvite).not.toHaveBeenCalled();
      expect(acceptInvite).not.toHaveBeenCalled();
    } finally {
      await runCauseEffect(manager.stop());
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("disconnects a stored WebRTC host removed from the authenticated directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-revoked-host-"));
    const statePath = join(directory, "servers.json");
    const hostId = "revoked-host";
    await writeFile(
      statePath,
      JSON.stringify({
        version: 3,
        activeServerId: hostId,
        servers: [
          {
            id: hostId,
            name: "Revoked host",
            apiUrl: `webrtc://${hostId}`,
            fingerprint: fingerprint("trusted-host-public-key"),
            publicKey: "trusted-host-public-key",
            username: "person@example.com",
            encryptedToken: "",
            remoteDesktopAvailable: true,
            logoVersion: null,
            role: "member",
            transport: "webrtc-v2",
          },
        ],
      }),
    );
    const bridge = new TeamWebRtcBridge();
    const disconnect = vi.spyOn(bridge, "disconnect").mockReturnValue(Effect.void);
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: () => authCall(async () => []),
      startSession: () => authCall(async () => ({ sessionId: "session-1", hostId, expiresAt: Date.now() + 60_000 })),
      issueTicket: () =>
        authCall(async () => ({
          ticket: "ticket",
          expiresAt: Date.now() + 60_000,
          signalUrl: "wss://signal.openbot.run/v1/signal",
        })),
      endSession: () => authCall(async () => undefined),
      createInvite: () =>
        authCall(async () => ({
          inviteId: "invite-1",
          token: "token",
          expiresAt: Date.now() + 60_000,
          permanent: false,
          useCount: 0,
        })),
      listInvites: () => authCall(async () => []),
      previewInvite: () =>
        authCall(async () => ({
          inviteId: "invite-1",
          hostId,
          hostName: "Revoked host",
          role: "member",
          expiresAt: Date.now() + 60_000,
          emailBound: false,
          permanent: false,
          devicePublicKey: "trusted-host-public-key",
        })),
      acceptInvite: () => authCall(async () => ({ hostId, membershipId: "membership-1", role: "member" })),
      revokeInvite: () => authCall(async () => undefined),
      listMembers: () => authCall(async () => []),
      updateMember: () => authCall(async () => undefined),
      removeMember: () => authCall(async () => undefined),
      getPrincipalId: () => "person-1",
      controlPlaneUrl: "https://api.openbot.run",
      downloadHostLogo: () => authCall(async () => ({ bytes: new Uint8Array(), mimeType: "image/png" })),
      transferDirectory: join(directory, "transfers"),
    });
    const manager = new RemoteServerManager(
      statePath,
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      { createTeamAuthTicket: () => authCall(async () => "ticket"), getEmail: () => "person@example.com" },
      { webrtcTransport: transport },
    );

    try {
      await runCauseEffect(manager.initialize());
      expect(disconnect).toHaveBeenCalledWith(hostId);
      expect(manager.list().map((server) => server.id)).toEqual(["local"]);
      expect(manager.activeServerId).toBe("local");
    } finally {
      await runCauseEffect(manager.stop());
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a WebRTC host when the development bootstrap offers the same host over HTTP", async () => {
    const hostId = "00000000-0000-4000-8000-0000000000fd";
    const fixture = await createRemoteManager({
      servers: [storedHttpsServer(hostId, { transport: "webrtc-v2", apiUrl: `webrtc://${hostId}` })],
    });
    // No routes: reaching the dev host over HTTP at all fails the test by name.
    const team = stubTeamFetch();

    const summary = await runCauseEffect(
      fixture.manager.connectDevelopmentServer({
        serverId: hostId,
        serverName: "OpenBot Local Dev Host",
        apiUrl: "http://localhost:63762",
        fingerprint: "fingerprint",
        publicKey: "public-key",
        username: "openbot-dev-client",
        sessionToken: "development-token",
      }),
    );

    expect(team.calls).toEqual([]);
    expect(summary).toMatchObject({ id: hostId, apiUrl: null });
    expect(fixture.server(hostId)).toMatchObject({ apiUrl: null });
  });

  it("keeps the saved WebRTC host order and loads Remote Desktop readiness after connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-host-order-"));
    const statePath = join(directory, "servers.json");
    const alphaId = "00000000-0000-4000-8000-000000000001";
    const betaId = "00000000-0000-4000-8000-000000000002";
    const gammaId = "00000000-0000-4000-8000-000000000003";
    const storedWebRtcServer = (id: string, name: string) => ({
      id,
      name,
      apiUrl: `webrtc://${id}`,
      fingerprint: fingerprint(`${id}-public-key`),
      publicKey: `${id}-public-key`,
      username: "person@example.com",
      encryptedToken: "",
      remoteDesktopAvailable: true,
      logoVersion: null,
      role: "member" as const,
      transport: "webrtc-v2" as const,
    });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 3,
        activeServerId: betaId,
        servers: [storedWebRtcServer(betaId, "Beta"), storedWebRtcServer(alphaId, "Alpha")],
      }),
    );
    let hosts = [
      { hostId: alphaId, name: "Alpha", devicePublicKey: `${alphaId}-public-key` },
      { hostId: betaId, name: "Beta", devicePublicKey: `${betaId}-public-key` },
      { hostId: gammaId, name: "Gamma", devicePublicKey: `${gammaId}-public-key` },
    ].map((host) => {
      const role: "owner" | "member" = host.hostId === gammaId ? "owner" : "member";
      return {
        ...host,
        logoKey: null,
        authEpoch: 1,
        membershipId: `${host.hostId}-member`,
        role,
      };
    });
    const bridge = new TeamWebRtcBridge();
    vi.spyOn(bridge, "disconnect").mockReturnValue(Effect.void);
    const removeMember = vi.fn((hostId: string) =>
      authCall(async () => {
        hosts = hosts.filter((host) => host.hostId !== hostId);
      }),
    );
    const revokeInvite = vi.fn(() => authCall(async () => undefined));
    const sendTeamInviteEmail = vi.fn(() => authCall(async () => undefined));
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: () => authCall(async () => hosts),
      startSession: (hostId) =>
        authCall(async () => ({ sessionId: "session-1", hostId, expiresAt: Date.now() + 60_000 })),
      issueTicket: () =>
        authCall(async () => ({ ticket: "ticket", expiresAt: Date.now() + 60_000, signalUrl: "wss://signal" })),
      endSession: () => authCall(async () => undefined),
      createInvite: () =>
        authCall(async () => ({
          inviteId: "invite-1",
          token: "t".repeat(43),
          expiresAt: Date.now() + 60_000,
          permanent: false,
          useCount: 0,
        })),
      listInvites: () => authCall(async () => []),
      previewInvite: () =>
        authCall(async () => {
          throw new Error("Unexpected invite preview.");
        }),
      acceptInvite: () =>
        authCall(async () => {
          throw new Error("Unexpected invite acceptance.");
        }),
      revokeInvite,
      listMembers: () => authCall(async () => []),
      updateMember: () => authCall(async () => undefined),
      removeMember,
      getPrincipalId: () => "person-1",
      controlPlaneUrl: "https://api.openbot.run",
      downloadHostLogo: () => authCall(async () => ({ bytes: new Uint8Array(), mimeType: "image/png" })),
      transferDirectory: join(directory, "transfers"),
    });
    const request = vi.spyOn(transport, "request").mockImplementation((_hostId, path) =>
      remoteCall(async (): Promise<TeamProtocolV2Json> => {
        if (path === "/v1/agents") return [];
        if (path === "/v1/compatibility") {
          return {
            appVersion: "0.4.0",
            protocol: { minimum: 1, maximum: 1 },
            capabilities: [...TEAM_CURRENT_CAPABILITIES],
          } satisfies TeamProtocolV2Json;
        }
        return {
          ready: true,
          platform: "linux",
          unattended: true,
          runtime: "sunshine-moonlight",
          protocolVersion: 2,
          displays: [],
          selectedDisplayId: null,
          activeSessions: 0,
          maxSessions: 1,
        } satisfies TeamProtocolV2Json;
      }),
    );
    const manager = new RemoteServerManager(
      statePath,
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      {
        createTeamAuthTicket: () => authCall(async () => "ticket"),
        getEmail: () => "person@example.com",
        sendTeamInviteEmail,
      },
      { appVersion: "0.4.0", webrtcTransport: transport },
    );

    try {
      await runCauseEffect(manager.initialize());
      expect(
        manager
          .list()
          .slice(1)
          .map((server) => server.id),
      ).toEqual([betaId, alphaId, gammaId]);
      expect(manager.list().find((server) => server.id === betaId)?.remoteDesktopAvailable).toBe(false);
      const roster = vi.fn();
      manager.on("agent", roster);
      transport.emit("connected", betaId);
      await vi.waitFor(() => expect(roster).toHaveBeenCalledWith(betaId, { type: "agents-changed", agents: [] }));
      await vi.waitFor(() =>
        expect(manager.list().find((server) => server.id === betaId)?.remoteDesktopAvailable).toBe(true),
      );
      const compatibility = manager.list().find((server) => server.id === betaId)?.compatibility;
      expect(compatibility).toMatchObject({ negotiatedProtocol: 2 });
      expect(compatibility?.capabilities).toContain("installed-skills");
      expect(request).toHaveBeenCalledWith(betaId, "/v1/remote-screen/capabilities", {
        preserveSemanticTags: true,
      });
      const invite = await runCauseEffect(
        manager.createInvite(betaId, { role: "member", email: "friend@example.com" }),
      );
      expect(sendTeamInviteEmail).toHaveBeenCalledWith({
        email: "friend@example.com",
        serverName: "Beta",
        inviteUrl: invite.inviteUrl,
        role: "member",
      });
      sendTeamInviteEmail.mockReturnValueOnce(
        Effect.fail(new CentralAuthOperationError({ cause: new Error("SMTP unavailable") })),
      );
      await expect(
        runCauseEffect(manager.createInvite(betaId, { role: "member", email: "failed@example.com" })),
      ).rejects.toThrow("SMTP unavailable");
      expect(revokeInvite).toHaveBeenCalledWith("invite-1");
      await runCauseEffect(manager.remove(alphaId));
      expect(removeMember).toHaveBeenCalledWith(alphaId, `${alphaId}-member`);
      await runCauseEffect(manager.syncRemoteHosts());
      expect(manager.list().some((server) => server.id === alphaId)).toBe(false);
      await runCauseEffect(manager.remove(gammaId));
      await runCauseEffect(manager.syncRemoteHosts());
      expect(manager.list().some((server) => server.id === gammaId)).toBe(false);
      expect(removeMember).not.toHaveBeenCalledWith(gammaId, `${gammaId}-member`);
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ hiddenHostIds: [gammaId] });
      const directoryChanged = vi.fn(() => runCauseEffect(manager.syncRemoteHosts()));
      manager.on("directoryInvalidated", directoryChanged);
      hosts = hosts.filter((host) => host.hostId !== betaId);
      transport.emit("error", betaId, "session_revoked", "The remote session was revoked.");
      expect(manager.list().find((server) => server.id === betaId)).toMatchObject({
        state: "error",
        issue: { code: "authentication_required", retryable: false },
      });
      await vi.waitFor(() => expect(manager.list().some((server) => server.id === betaId)).toBe(false));
      expect(directoryChanged).toHaveBeenCalledOnce();
      // The sync writes servers.json after the list changes. Let it finish before cleanup removes the directory.
      await directoryChanged.mock.results[0]?.value;
      expect(manager.activeServerId).toBe("local");
    } finally {
      await runCauseEffect(manager.stop());
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sends viewer JSON through RPC and keeps viewer authorization errors scoped to Remote Desktop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-viewer-"));
    const statePath = join(directory, "servers.json");
    const hostId = "viewer-host";
    const publicKey = "viewer-host-public-key";
    await writeFile(
      statePath,
      JSON.stringify({
        version: 3,
        activeServerId: hostId,
        servers: [
          {
            id: hostId,
            name: "Viewer host",
            apiUrl: `webrtc://${hostId}`,
            fingerprint: fingerprint(publicKey),
            publicKey,
            username: "person@example.com",
            encryptedToken: "",
            remoteDesktopAvailable: true,
            logoVersion: null,
            role: "member",
            transport: "webrtc-v2",
          },
        ],
      }),
    );
    const bridge = new TeamWebRtcBridge();
    vi.spyOn(bridge, "disconnect").mockReturnValue(Effect.void);
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: () =>
        authCall(async () => [
          {
            hostId,
            name: "Viewer host",
            logoKey: null,
            devicePublicKey: publicKey,
            authEpoch: 1,
            membershipId: "member-1",
            role: "member",
          },
        ]),
      startSession: () => authCall(async () => ({ sessionId: "session-1", hostId, expiresAt: Date.now() + 60_000 })),
      issueTicket: () =>
        authCall(async () => ({
          ticket: "ticket",
          expiresAt: Date.now() + 60_000,
          signalUrl: "wss://signal.openbot.run/v1/signal",
        })),
      endSession: () => authCall(async () => undefined),
      createInvite: () =>
        authCall(async () => ({
          inviteId: "invite-1",
          token: "token",
          expiresAt: Date.now() + 60_000,
          permanent: false,
          useCount: 0,
        })),
      listInvites: () => authCall(async () => []),
      previewInvite: () =>
        authCall(async () => {
          throw new Error("Unexpected invite preview.");
        }),
      acceptInvite: () =>
        authCall(async () => {
          throw new Error("Unexpected invite acceptance.");
        }),
      revokeInvite: () => authCall(async () => undefined),
      listMembers: () => authCall(async () => []),
      updateMember: () => authCall(async () => undefined),
      removeMember: () => authCall(async () => undefined),
      getPrincipalId: () => "person-1",
      controlPlaneUrl: "https://api.openbot.run",
      downloadHostLogo: () => authCall(async () => ({ bytes: new Uint8Array(), mimeType: "image/png" })),
      transferDirectory: join(directory, "transfers"),
    });
    const requestResponse = vi
      .spyOn(transport, "requestResponse")
      .mockReturnValueOnce(Effect.succeed({ status: 204, body: {} }))
      .mockReturnValueOnce(
        Effect.fail(
          new RemoteWorkflowError({
            cause: new TeamWebRtcRequestError(401, "session_expired", "Viewer grant expired."),
          }),
        ),
      );
    const manager = new RemoteServerManager(
      statePath,
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      { createTeamAuthTicket: () => authCall(async () => "ticket"), getEmail: () => "person@example.com" },
      { webrtcTransport: transport },
    );

    try {
      await runCauseEffect(manager.initialize());
      const authorization = await runCauseEffect(
        manager.fetchRemoteViewerResource(hostId, "/v1/remote-screen/sessions/desktop-1/authorize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify({ grant: "viewer-grant" })),
        }),
      );
      expect(authorization.status).toBe(204);
      expect(requestResponse).toHaveBeenNthCalledWith(1, hostId, "/v1/remote-screen/sessions/desktop-1/authorize", {
        method: "POST",
        body: { grant: "viewer-grant" },
        contentType: "application/json",
        preserveSemanticTags: false,
      });

      await expect(
        runCauseEffect(
          manager.fetchRemoteViewerResource(hostId, "/v1/remote-screen/sessions/desktop-1/authorize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: new TextEncoder().encode(JSON.stringify({ grant: "expired" })),
          }),
        ),
      ).rejects.toThrow("Viewer grant expired.");
      expect(manager.list().find((server) => server.id === hostId)?.issue).toBeNull();
    } finally {
      await runCauseEffect(manager.stop());
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("remote server order", () => {
  it("recovers the persistence queue after a write failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-server-persistence-"));
    const unavailableDirectory = `${directory}-unavailable`;
    const statePath = join(directory, "servers.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        activeServerId: "local",
        servers: [
          {
            id: "server-1",
            name: "Remote",
            apiUrl: "https://server-1.trycloudflare.com/",
            fingerprint: "fingerprint",
            username: "person@example.com",
            encryptedToken: "token",
            remoteDesktopAvailable: false,
            role: "member",
          },
        ],
      }),
    );
    const manager = new RemoteServerManager(
      statePath,
      {
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => value.toString(),
      },
      {
        createTeamAuthTicket: () => authCall(async () => "ticket"),
        getEmail: () => "person@example.com",
      },
    );

    try {
      await runCauseEffect(manager.initialize());
      await rename(directory, unavailableDirectory);
      await expect(runCauseEffect(manager.select("server-1"))).rejects.toThrow();
      expect(manager.activeServerId).toBe("local");
      await rename(unavailableDirectory, directory);

      await expect(runCauseEffect(manager.select("local"))).resolves.toBeDefined();
      const persisted = JSON.parse(await readFile(statePath, "utf8"));
      expect(persisted.activeServerId).toBe("local");
    } finally {
      await runCauseEffect(manager.stop());
      await rm(directory, { recursive: true, force: true });
      await rm(unavailableDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the local server first and persists the remote server order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-server-order-"));
    const statePath = join(directory, "servers.json");
    const storedServer = (id: string) => ({
      id,
      name: id,
      apiUrl: `https://${id}.trycloudflare.com/`,
      fingerprint: "fingerprint",
      username: "person@example.com",
      encryptedToken: "token",
      role: "member" as const,
    });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        activeServerId: "server-1",
        servers: [storedServer("server-1"), storedServer("server-2")],
      }),
    );

    try {
      const manager = new RemoteServerManager(
        statePath,
        {
          encrypt: (value) => Buffer.from(value),
          decrypt: (value) => value.toString(),
        },
        {
          createTeamAuthTicket: () => authCall(async () => "ticket"),
          getEmail: () => "person@example.com",
        },
      );
      await runCauseEffect(manager.initialize());

      const reordered = await runCauseEffect(manager.reorder(["server-2", "server-1"]));
      expect(reordered.map((server) => server.id)).toEqual(["local", "server-2", "server-1"]);
      expect(reordered.find((server) => server.id === "server-1")?.active).toBe(true);

      const persisted = JSON.parse(await readFile(statePath, "utf8"));
      expect(persisted.servers.map((server: { id: string }) => server.id)).toEqual(["server-2", "server-1"]);
      await expect(runCauseEffect(manager.reorder(["server-1"]))).rejects.toThrow("incomplete");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("downloads shared and workspace files with authenticated requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-shared-download-"));
    const statePath = join(directory, "servers.json");
    const serverId = "remote-shared";
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        activeServerId: serverId,
        servers: [
          {
            id: serverId,
            name: "Remote",
            apiUrl: "https://remote-shared.trycloudflare.com/",
            fingerprint: "fingerprint",
            username: "person@example.com",
            encryptedToken: Buffer.from("session-token").toString("base64"),
            remoteDesktopAvailable: false,
            role: "member",
          },
        ],
      }),
    );

    const bytes = new TextEncoder().encode("name,value\nOpenBot,1\n");
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer session-token");
      expect(headers.get("OpenBot-Protocol-Version")).toBe("1");
      if (url.pathname === "/v1/shared-files") {
        expect(url.searchParams.get("path")).toBe("~/OpenBot/Shared/report.csv");
      } else {
        expect(url.pathname).toBe("/v1/workspace-files");
        // Read off the URL this client puts on the wire, so it carries the frozen `botId` spelling.
        expect(url.searchParams.get("botId")).toBe("chief");
        expect(url.searchParams.get("path")).toBe("app/page.tsx");
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Disposition": `attachment; filename*=UTF-8''${url.pathname.includes("workspace") ? "page%E0%A4%A.tsx" : "report.csv"}`,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const manager = new RemoteServerManager(
        statePath,
        {
          encrypt: (value) => Buffer.from(value),
          decrypt: (value) => value.toString(),
        },
        {
          createTeamAuthTicket: () => authCall(async () => "ticket"),
          getEmail: () => "person@example.com",
        },
      );
      await runCauseEffect(manager.initialize());

      await expect(
        runCauseEffect(manager.downloadSharedFile("~/OpenBot/Shared/report.csv", serverId)),
      ).resolves.toEqual({
        bytes,
        name: "report.csv",
      });
      // A name that is not valid percent-encoding does not fail a download that has its bytes.
      await expect(runCauseEffect(manager.downloadWorkspaceFile("chief", "app/page.tsx", serverId))).resolves.toEqual({
        bytes,
        name: "page.tsx",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await runCauseEffect(manager.stop());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("remote connection failures", () => {
  // The one place a request failure and the live channel meet. `RemoteServerConnections` decides the
  // failure is not worth retrying and calls back; only the event stream knows there is a socket to
  // tear down for it. Neither names the other, so this is the test that the manager still wires them
  // together.
  it("closes the event data plane after a malformed HTTP payload", async () => {
    stubTeamFetch({
      compatibility: { appVersion: "0.3.0", capabilities: ["agent-runtime-snapshots"] },
      fallback: () => Response.json({ malformed: true }),
    });
    const { sockets } = stubEventSockets();
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("http-protocol")], appVersion: "0.4.0" });

    void runCauseEffect(fixture.manager.startEventConnections());
    await waitForServer(fixture, { state: "online" });

    await expect(
      runCauseEffect(fixture.manager.request("http-protocol", "/v1/agents", (value) => value)),
    ).rejects.toThrow("could not safely use");

    expect(sockets[0]?.close).toHaveBeenCalledWith(1000, "Client stopped");
    expect(fixture.server()).toMatchObject({ state: "error", issue: { code: "protocol_error" } });
  });

  // The same wiring for a WebRTC host, which has no socket to abort: its events arrive on a data
  // channel the transport owns, so suspending the stream alone left the host pushing events after
  // the app decided it could not understand the answers it gives.
  it("closes the event data plane of a WebRTC host that answers with nonsense", async () => {
    const hostId = "00000000-0000-4000-8000-0000000000ff";
    const transport = fakeWebRtcTransport([
      {
        hostId,
        name: "Host",
        logoKey: null,
        devicePublicKey: null,
        authEpoch: 1,
        membershipId: "member-1",
        role: "member",
      },
    ]);
    const disconnect = vi.spyOn(transport, "disconnect");
    vi.spyOn(transport, "request").mockImplementation((_hostId, path) =>
      remoteCall(async (): Promise<TeamProtocolV2Json> => {
        if (path !== "/v1/compatibility") return { malformed: true };
        return { appVersion: "0.4.0", protocol: { minimum: 2, maximum: 2 }, capabilities: [] };
      }),
    );
    const fixture = await createRemoteManager({
      servers: [storedHttpsServer(hostId, { transport: "webrtc-v2", apiUrl: `webrtc://${hostId}` })],
      appVersion: "0.4.0",
      managerOptions: { webrtcTransport: transport },
    });

    await expect(
      runCauseEffect(
        fixture.manager.request(hostId, "/v1/agents", () => {
          throw new Error("Unexpected agent payload.");
        }),
      ),
    ).rejects.toThrow("could not safely use");

    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith(hostId));

    // The disconnect the app asked for comes back as an event, and it must not be read as the host
    // merely going away: the failure that caused it is what the user has to see.
    transport.emit("disconnected", hostId);
    expect(fixture.server(hostId)).toMatchObject({ state: "error", issue: { code: "protocol_error" } });

    // Retrying by hand is the act the suspension was waiting for. A host still suspended after it
    // reads every later disconnect as the old failure and never reconnects on its own again.
    vi.spyOn(transport, "connect").mockReturnValue(Effect.succeed(undefined));
    await runCauseEffect(fixture.manager.retryConnection(hostId));
    transport.emit("disconnected", hostId);
    expect(fixture.server(hostId)).toMatchObject({ state: "offline" });
  });

  it("loads agents after reconnecting a host whose previous protocol error is fixed", async () => {
    const hostId = "00000000-0000-4000-8000-0000000000fd";
    const transport = fakeWebRtcTransport([
      {
        hostId,
        name: "Host",
        logoKey: null,
        devicePublicKey: null,
        authEpoch: 1,
        membershipId: "member-1",
        role: "member",
      },
    ]);
    vi.spyOn(transport, "request").mockImplementation((_hostId, path) =>
      remoteCall(async (): Promise<TeamProtocolV2Json> => {
        if (path === "/v1/compatibility")
          return { appVersion: "0.4.0", protocol: { minimum: 2, maximum: 2 }, capabilities: [] };
        return [];
      }),
    );
    const fixture = await createRemoteManager({
      servers: [storedHttpsServer(hostId, { transport: "webrtc-v2", apiUrl: `webrtc://${hostId}` })],
      appVersion: "0.4.0",
      managerOptions: { webrtcTransport: transport },
    });
    await expect(
      runCauseEffect(
        fixture.manager.request(hostId, "/v1/agents", () => {
          throw new Error("Old invalid payload.");
        }),
      ),
    ).rejects.toThrow("could not safely use");
    const roster = vi.fn();
    fixture.manager.on("agent", roster);
    const disconnect = vi.spyOn(transport, "disconnect");
    vi.spyOn(transport, "connect").mockImplementation(() =>
      remoteCall(async () => {
        transport.emit("connected", hostId);
      }),
    );
    await runCauseEffect(fixture.manager.retryConnection(hostId));
    await vi.waitFor(() => expect(roster).toHaveBeenCalledWith(hostId, { type: "agents-changed", agents: [] }));
    expect(fixture.server(hostId)).toMatchObject({ state: "online", issue: null });
    expect(disconnect).not.toHaveBeenCalled();
  });

  // A retry has to leave a working host reading as working. `connect` on a channel that never
  // dropped announces nothing -- there is no new session to announce -- so nothing else clears the
  // "connecting" the retry itself just set, and the host read as reconnecting for as long as it
  // stayed up.
  it("puts a WebRTC host that was already connected back to online after a retry", async () => {
    const hostId = "00000000-0000-4000-8000-0000000000fe";
    const transport = fakeWebRtcTransport([
      {
        hostId,
        name: "Host",
        logoKey: null,
        devicePublicKey: null,
        authEpoch: 1,
        membershipId: "member-1",
        role: "member",
      },
    ]);
    vi.spyOn(transport, "connect").mockReturnValue(Effect.succeed(undefined));
    vi.spyOn(transport, "isConnected").mockReturnValue(true);
    const fixture = await createRemoteManager({
      servers: [storedHttpsServer(hostId, { transport: "webrtc-v2", apiUrl: `webrtc://${hostId}` })],
      appVersion: "0.4.0",
      managerOptions: { webrtcTransport: transport },
    });

    await runCauseEffect(fixture.manager.retryConnection(hostId));

    expect(fixture.server(hostId)).toMatchObject({ state: "online" });
  });

  // Signing in ends with the desktop probe, whose rejection `login` deliberately swallows -- the
  // credentials are already on disk. Swallowing the rejection must not swallow what it recorded: the
  // stream restart lifts the suspension and opening the socket clears the issue, so whichever of the
  // two runs last decides whether a host answering with nonsense ends up online.
  it("keeps a protocol failure the sign-in's last request recorded", async () => {
    const serverId = "00000000-0000-4000-8000-00000000001a";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    const probe = deferredRoute();
    stubTeamFetch({
      compatibility: { capabilities: ["remote-desktop", "agent-runtime-snapshots"] },
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId,
            publicKey: publicKeyPem,
            serverName: "Host",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        "/v1/auth/account": () =>
          Response.json({
            member: {
              id: "member-id",
              username: "member",
              email: "person@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "session-token",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        "/v1/remote-screen/capabilities": probe.handler,
      },
    });
    const { sockets } = stubEventSockets();
    const fixture = await createRemoteManager({
      servers: [storedHttpsServer(serverId, { fingerprint: hostFingerprint, publicKey: publicKeyPem })],
      appVersion: "0.4.0",
    });

    void runCauseEffect(fixture.manager.startEventConnections());
    await waitForServer(fixture, { state: "online" });
    const signedIn = runCauseEffect(fixture.manager.login({ serverId }));

    // The probe is in flight, and the stream has already restarted on the new token: a second socket
    // exists. That order is the whole point -- the restart cannot come after the answer below.
    await probe.arrived;
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    probe.resolve(Response.json({ malformed: true }));
    await signedIn;

    await vi.waitFor(() => expect(sockets[1]?.close).toHaveBeenCalledWith(1000, "Client stopped"));
    expect(fixture.server(serverId)).toMatchObject({ state: "error", issue: { code: "protocol_error" } });
  });
});

describe("remote control capability discovery", () => {
  it("does not import or prune a host with a pending rejoin for another account", async () => {
    const hostId = "22222222-2222-4222-8222-222222222222";
    const registerAccountServer = vi.fn(() => authCall(async () => []));
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl: "http://100.100.100.107:43123/",
          membershipId: "member-from-account-a",
          accountId: "account-a",
          pendingAccountRejoinId: "account-a",
        }),
      ],
      account: {
        getAccountId: () => "account-b",
        isSelfHostedSignedIn: () => true,
        listAccountServers: () => authCall(async () => []),
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        registerAccountServer,
      },
      managerOptions: { allowTailscaleApiUrl: true, localOnlyNetworking: true },
    });
    const login = vi.spyOn(fixture.manager, "login");

    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(login).not.toHaveBeenCalled();
    expect(registerAccountServer).not.toHaveBeenCalled();
    expect(fixture.manager.list().map((server) => server.id)).not.toContain(hostId);
    expect(await readFile(fixture.statePath, "utf8")).toContain("member-from-account-a");
  });

  it("does not import an unclaimed local host without a pinned identity", async () => {
    const hostId = "unclaimed-local-host";
    const registerAccountServer = vi.fn(() => authCall(async () => []));
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl: "http://100.100.100.107:43123/",
          membershipId: "legacy-membership",
        }),
      ],
      account: {
        getAccountId: () => "account-b",
        isSelfHostedSignedIn: () => true,
        listAccountServers: () => authCall(async () => []),
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        registerAccountServer,
      },
      managerOptions: { allowTailscaleApiUrl: true, localOnlyNetworking: true },
    });

    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(registerAccountServer).not.toHaveBeenCalled();
    expect(fixture.manager.list().map((server) => server.id)).not.toContain(hostId);
    expect(await readFile(fixture.statePath, "utf8")).toContain("legacy-membership");
  });

  it("migrates a legacy pairing only after the current account authenticates with a fresh ticket", async () => {
    const hostId = "legacy-account-host";
    const apiUrl = "http://100.100.100.107:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    const { requests } = stubTeamFetch({
      compatibility: { capabilities: [TEAM_MEMBER_DEVICE_LINK_CAPABILITY] },
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId: hostId,
            publicKey: publicKeyPem,
            serverName: "Legacy host",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        "/v1/auth/account": () =>
          Response.json({
            member: {
              id: "confirmed-member",
              username: "member",
              email: "person@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "fresh-account-session",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        "/v1/remote-screen/capabilities": () =>
          Response.json({ error: "Remote control is unavailable.", code: "host_unavailable" }, { status: 503 }),
      },
    });
    let entries: AccountServerDirectoryEntry[] = [];
    const registerAccountServer = vi.fn((registration: AccountServerRegistration) =>
      authCall(async () => {
        const { legacyImport: _legacyImport, rejoin: _rejoin, ...entry } = registration;
        entries = [{ ...entry, isOwner: false }];
      }),
    );
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl,
          fingerprint: hostFingerprint,
          publicKey: publicKeyPem,
          membershipId: "legacy-member",
        }),
      ],
      activeServerId: LOCAL_SERVER_ID,
      account: {
        createTeamAuthTicket: () => authCall(async () => "current-account-ticket"),
        getAccountId: () => "account-b",
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () => authCall(async () => entries),
        isSelfHostedSignedIn: () => true,
        registerAccountServer,
      },
      managerOptions: { allowTailscaleApiUrl: true, localOnlyNetworking: true },
    });

    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(requests(TEAM_API_ROUTES.auth.account)).toHaveLength(1);
    expect(requests(TEAM_API_ROUTES.auth.account)[0]?.body).toEqual({ accountTicket: "current-account-ticket" });
    expect(registerAccountServer).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId,
        membershipId: "confirmed-member",
        legacyImport: true,
      }),
    );
    expect(fixture.server(hostId)).toMatchObject({ id: hostId, role: "member", state: "connecting" });
    expect(fixture.manager.activeServerId).toBe(LOCAL_SERVER_ID);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      servers: expect.arrayContaining([
        expect.objectContaining({
          id: hostId,
          accountId: "account-b",
          membershipId: "confirmed-member",
        }),
      ]),
    });
  });

  it("publishes a self-hosted Tailscale join without failing if directory registration is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-remote-capability-"));
    const statePath = join(directory, "servers.json");
    const serverId = "00000000-0000-4000-8000-000000000000";
    const apiUrl = "http://100.100.100.107:43123/";
    let directoryEntries: AccountServerDirectoryEntry[] = [];
    let registrationAttempts = 0;
    const registerAccountServer = vi.fn((registration: AccountServerRegistration) =>
      authCall(async () => {
        if (registrationAttempts++ === 0) throw new Error("Account directory is unavailable.");
        const { legacyImport: _legacyImport, rejoin: _rejoin, ...entry } = registration;
        directoryEntries = [{ ...entry, isOwner: false }];
      }),
    );
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const expectedFingerprint = fingerprint(publicKeyPem);
    const inviteUrl = new URL("openbot://join");
    inviteUrl.searchParams.set("api", apiUrl);
    inviteUrl.searchParams.set("server", serverId);
    inviteUrl.searchParams.set("fingerprint", expectedFingerprint);
    inviteUrl.searchParams.set("invite", "b".repeat(43));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const pathname = url.pathname.replace(/^\/+/, "/");
        if (pathname === "/v1/identity") {
          const challenge = url.searchParams.get("challenge");
          if (!challenge) throw new Error("The identity challenge is missing.");
          return Response.json({
            serverId,
            publicKey: publicKeyPem,
            serverName: "Capability Host",
            fingerprint: expectedFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        }
        if (pathname === "/v1/join/account") {
          return Response.json({
            member: {
              id: "member-id",
              username: "member",
              email: "member@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "session-token",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        if (pathname === "/v1/remote-screen/capabilities") {
          return Response.json({ error: "Remote control is unavailable.", code: "host_unavailable" }, { status: 503 });
        }
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );

    class ClosedWebSocket extends EventTarget {
      close(): void {
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", ClosedWebSocket);

    try {
      const makeManager = () =>
        new RemoteServerManager(
          statePath,
          {
            encrypt: (value) => Buffer.from(value),
            decrypt: (value) => value.toString(),
          },
          {
            createTeamAuthTicket: () => authCall(async () => "account-ticket"),
            getEmail: () => "member@example.com",
            getAccountId: () => "member-account",
            isSelfHostedSignedIn: () => true,
            listAccountServers: () => authCall(async () => directoryEntries),
            getLegacyAccountServerImportExclusions: () => authCall(async () => [serverId]),
            registerAccountServer,
          },
          { localOnlyNetworking: true, allowTailscaleApiUrl: true },
        );
      let manager = makeManager();
      await runCauseEffect(manager.initialize());

      await expect(runCauseEffect(manager.join({ inviteUrl: inviteUrl.toString() }))).resolves.toMatchObject({
        id: serverId,
        remoteDesktopAvailable: false,
        state: "online",
      });
      expect(registerAccountServer).toHaveBeenCalledWith({
        hostId: serverId,
        name: "Capability Host",
        apiUrl,
        fingerprint: expectedFingerprint,
        publicKey: publicKeyPem,
        logoKey: null,
        membershipId: "member-id",
        role: "member",
        rejoin: true,
      });
      await runCauseEffect(manager.stop());

      // The invitation is single-use. A later account-directory retry must find the durable pending
      // rejoin marker, retry with the same device token, and keep the host in the local list.
      manager = makeManager();
      await runCauseEffect(manager.initialize());
      await runCauseEffect(manager.syncAccountDirectory());
      expect(registerAccountServer).toHaveBeenCalledTimes(2);
      expect(registerAccountServer.mock.calls[1]?.[0]).toMatchObject({ rejoin: true, membershipId: "member-id" });
      expect(manager.list().map((server) => server.id)).toContain(serverId);
      expect(await readFile(statePath, "utf8")).not.toContain("pendingAccountRejoinId");
      await runCauseEffect(manager.stop());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("self-hosted account server directory", () => {
  it("renews a device-local Team token when the signed-in account retries a host", async () => {
    const serverId = "33333333-3333-4333-8333-333333333333";
    const apiUrl = "http://100.100.100.107:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    const authTicket = vi.fn((hostId: string) =>
      authCall(async () => (hostId === serverId ? "fresh-account-ticket" : "wrong-host-ticket")),
    );
    const host = stubTeamFetch({
      compatibility: { appVersion: "0.30.0", capabilities: [] },
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId,
            publicKey: publicKeyPem,
            serverName: "Linux host",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        [TEAM_API_ROUTES.auth.account]: () =>
          Response.json({
            member: {
              id: "member-1",
              username: "member",
              email: "person@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "fresh-device-token",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
      },
    });
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(serverId, {
          apiUrl,
          fingerprint: hostFingerprint,
          publicKey: publicKeyPem,
          membershipId: "member-1",
          accountId: "account-a",
          role: "member",
          encryptedToken: Buffer.from("expired-device-token").toString("base64"),
        }),
      ],
      appVersion: "0.30.0",
      account: {
        createTeamAuthTicket: authTicket,
        getAccountId: () => "account-a",
        isSelfHostedSignedIn: () => true,
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await runCauseEffect(fixture.manager.retryConnection(serverId));

    expect(authTicket).toHaveBeenCalledExactlyOnceWith(serverId);
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(1);
    expect(host.requests(TEAM_API_ROUTES.auth.account)[0]?.body).toEqual({ accountTicket: "fresh-account-ticket" });
    const persisted = JSON.parse(await readFile(fixture.statePath, "utf8"));
    expect(persisted.servers[0]?.encryptedToken).toBe(Buffer.from("fresh-device-token").toString("base64"));
  });

  it("does not issue an account ticket when the host identity no longer matches the pin", async () => {
    const serverId = "44444444-4444-4444-8444-444444444444";
    const apiUrl = "http://100.100.100.108:43123/";
    const pinned = generateKeyPairSync("ed25519");
    const changed = generateKeyPairSync("ed25519");
    const pinnedPublicKey = pinned.publicKey.export({ type: "spki", format: "pem" }).toString();
    const changedPublicKey = changed.publicKey.export({ type: "spki", format: "pem" }).toString();
    const pinnedFingerprint = fingerprint(pinnedPublicKey);
    const changedFingerprint = fingerprint(changedPublicKey);
    const authTicket = vi.fn(() => authCall(async () => "must-not-be-issued"));
    stubTeamFetch({
      compatibility: { capabilities: [] },
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId,
            publicKey: changedPublicKey,
            serverName: "Changed host",
            fingerprint: changedFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), changed.privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
      },
    });
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(serverId, {
          apiUrl,
          fingerprint: pinnedFingerprint,
          publicKey: pinnedPublicKey,
          membershipId: "member-1",
          accountId: "account-a",
          encryptedToken: Buffer.from("old-device-token").toString("base64"),
        }),
      ],
      account: {
        createTeamAuthTicket: authTicket,
        getAccountId: () => "account-a",
        isSelfHostedSignedIn: () => true,
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await expect(runCauseEffect(fixture.manager.retryConnection(serverId))).rejects.toThrow();

    expect(authTicket).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(fixture.statePath, "utf8"));
    expect(persisted.servers[0]?.encryptedToken).toBe(Buffer.from("old-device-token").toString("base64"));
  });

  it("keeps the previous device token when the host rejects fresh account-ticket redemption", async () => {
    const serverId = "55555555-5555-4555-8555-555555555555";
    const apiUrl = "http://100.100.100.109:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    const authTicket = vi.fn(() => authCall(async () => "fresh-account-ticket"));
    const host = stubTeamFetch({
      compatibility: { capabilities: [] },
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId,
            publicKey: publicKeyPem,
            serverName: "Linux host",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        [TEAM_API_ROUTES.auth.account]: () => Response.json({ error: "Not authorized." }, { status: 401 }),
      },
    });
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(serverId, {
          apiUrl,
          fingerprint: hostFingerprint,
          publicKey: publicKeyPem,
          membershipId: "member-1",
          accountId: "account-a",
          encryptedToken: Buffer.from("old-device-token").toString("base64"),
        }),
      ],
      account: {
        createTeamAuthTicket: authTicket,
        getAccountId: () => "account-a",
        isSelfHostedSignedIn: () => true,
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await expect(runCauseEffect(fixture.manager.retryConnection(serverId))).rejects.toThrow();

    expect(authTicket).toHaveBeenCalledOnce();
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(1);
    const persisted = JSON.parse(await readFile(fixture.statePath, "utf8"));
    expect(persisted.servers[0]?.encryptedToken).toBe(Buffer.from("old-device-token").toString("base64"));
  });

  it("keeps an account-listed host visible while its Team API is temporarily unreachable", async () => {
    const hostId = "linux-account-server";
    const apiUrl = "http://100.100.100.107:43123/";
    const publicKey = "directory-public-key";
    const entry: AccountServerDirectoryEntry = {
      hostId,
      name: "Linux server",
      apiUrl,
      fingerprint: fingerprint(publicKey),
      publicKey,
      logoKey: null,
      membershipId: "account-member",
      role: "member",
      isOwner: false,
    };
    const hostFetch = stubTeamFetch({
      routes: {
        "/v1/identity": () => Response.json({ error: "Host unavailable." }, { status: 503 }),
      },
    });
    const fixture = await createRemoteManager({
      servers: [],
      account: {
        getAccountId: () => "account-a",
        getEmail: () => "person@example.com",
        isSelfHostedSignedIn: () => true,
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () => authCall(async () => [entry]),
        registerAccountServer: () => authCall(async () => undefined),
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(hostFetch.requests("/v1/identity")).toHaveLength(1);
    expect(fixture.server(hostId)).toMatchObject({ id: hostId, name: "Linux server", state: "offline" });
    expect(fixture.manager.activeServerId).toBe("local");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8")).servers).toContainEqual(
      expect.objectContaining({
        accountId: "account-a",
        membershipId: "account-member",
        pendingAccountAuthentication: true,
        encryptedToken: "",
      }),
    );
    await expect(runCauseEffect(fixture.manager.request(hostId, "/v1/test", (value) => value))).rejects.toThrow(
      "The selected server is offline.",
    );
  });

  it("backs off automatic adoption of a staged account server between five-second directory refreshes", async () => {
    const hostId = "linux-account-server";
    const apiUrl = "http://100.100.100.107:43123/";
    const publicKey = "directory-public-key";
    const entry: AccountServerDirectoryEntry = {
      hostId,
      name: "Linux server",
      apiUrl,
      fingerprint: fingerprint(publicKey),
      publicKey,
      logoKey: null,
      membershipId: "account-member",
      role: "member",
      isOwner: false,
    };
    const host = stubTeamFetch({
      routes: {
        "/v1/identity": () => Response.json({ error: "Host unavailable." }, { status: 503 }),
      },
    });
    const fixture = await createRemoteManager({
      servers: [],
      account: {
        getAccountId: () => "account-a",
        getEmail: () => "person@example.com",
        isSelfHostedSignedIn: () => true,
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () => authCall(async () => [entry]),
        registerAccountServer: () => authCall(async () => undefined),
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });
    let now = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      await runCauseEffect(fixture.manager.syncAccountDirectory());
      await runCauseEffect(fixture.manager.syncAccountDirectory());
      expect(host.requests("/v1/identity")).toHaveLength(1);
      expect(fixture.server(hostId)).toMatchObject({
        state: "offline",
        issue: { code: "network_unavailable", retryable: true },
      });

      now += 119_999;
      await runCauseEffect(fixture.manager.syncAccountDirectory());
      expect(host.requests("/v1/identity")).toHaveLength(1);

      now += 1;
      await runCauseEffect(fixture.manager.syncAccountDirectory());
      expect(host.requests("/v1/identity")).toHaveLength(2);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("keeps a staged host offline when Retry races an automatic adoption", async () => {
    const hostId = "linux-account-server";
    const apiUrl = "http://100.100.100.107:43123/";
    const publicKey = "directory-public-key";
    const entry: AccountServerDirectoryEntry = {
      hostId,
      name: "Linux server",
      apiUrl,
      fingerprint: fingerprint(publicKey),
      publicKey,
      logoKey: null,
      membershipId: "account-member",
      role: "member",
      isOwner: false,
    };
    const pendingIdentity = deferredRoute();
    let identityAttempts = 0;
    const host = stubTeamFetch({
      routes: {
        "/v1/identity": () => {
          identityAttempts += 1;
          return identityAttempts === 1
            ? Response.json({ error: "Host unavailable." }, { status: 503 })
            : pendingIdentity.handler({
                url: new URL(`${apiUrl}v1/identity`),
                path: "/v1/identity",
                headers: new Headers(),
                init: undefined,
                body: undefined,
              });
        },
      },
    });
    const createTeamAuthTicket = vi.fn(() => authCall(async () => "account-ticket"));
    const fixture = await createRemoteManager({
      servers: [],
      account: {
        createTeamAuthTicket,
        getAccountId: () => "account-a",
        getEmail: () => "person@example.com",
        isSelfHostedSignedIn: () => true,
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () => authCall(async () => [entry]),
        registerAccountServer: () => authCall(async () => undefined),
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });
    let now = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    let automaticAdoption: Promise<unknown> | undefined;

    try {
      await runCauseEffect(fixture.manager.syncAccountDirectory());
      now += 2 * 60_000;
      automaticAdoption = runCauseEffect(fixture.manager.syncAccountDirectory());
      await pendingIdentity.arrived;

      const retrySummary = await runCauseEffect(fixture.manager.retryConnection(hostId));
      expect(retrySummary).toMatchObject({ state: "offline" });
      expect(fixture.server(hostId)).toMatchObject({ state: "offline" });
      expect(host.requests("/v1/identity")).toHaveLength(2);
      expect(createTeamAuthTicket).not.toHaveBeenCalled();

      pendingIdentity.resolve(Response.json({ error: "Host unavailable." }, { status: 503 }));
      await automaticAdoption;
      expect(fixture.server(hostId)).toMatchObject({ state: "offline", issue: { retryable: true } });
      expect(host.requests("/v1/identity")).toHaveLength(2);
      expect(JSON.parse(await readFile(fixture.statePath, "utf8")).servers).toContainEqual(
        expect.objectContaining({ id: hostId, pendingAccountAuthentication: true }),
      );
    } finally {
      pendingIdentity.resolve(Response.json({ error: "Host unavailable." }, { status: 503 }));
      await automaticAdoption;
      dateNow.mockRestore();
    }
  });

  it("lets an explicit Retry re-authenticate after a host rate-limits a prior ticket", async () => {
    const hostId = "linux-account-server";
    const apiUrl = "http://100.100.100.107:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    let accountAttempts = 0;
    const host = stubTeamFetch({
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId: hostId,
            publicKey: publicKeyPem,
            serverName: "Linux server",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        [TEAM_API_ROUTES.auth.account]: () => {
          accountAttempts += 1;
          if (accountAttempts === 1) {
            return Response.json({ error: "Too many sign-in attempts." }, { status: 429 });
          }
          return Response.json({
            member: {
              id: "account-member",
              username: "member",
              email: "person@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "device-session-token",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        },
      },
    });
    const entry: AccountServerDirectoryEntry = {
      hostId,
      name: "Linux server",
      apiUrl,
      fingerprint: hostFingerprint,
      publicKey: publicKeyPem,
      logoKey: null,
      membershipId: "account-member",
      role: "member",
      isOwner: false,
    };
    const createTeamAuthTicket = vi.fn(() => authCall(async () => "account-ticket"));
    const fixture = await createRemoteManager({
      servers: [],
      account: {
        createTeamAuthTicket,
        getAccountId: () => "account-a",
        getEmail: () => "person@example.com",
        isSelfHostedSignedIn: () => true,
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () => authCall(async () => [entry]),
        registerAccountServer: () => authCall(async () => undefined),
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });
    const now = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);

    try {
      await runCauseEffect(fixture.manager.syncAccountDirectory());
      expect(createTeamAuthTicket).toHaveBeenCalledOnce();
      expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(1);
      expect(fixture.server(hostId)).toMatchObject({
        state: "offline",
        issue: { retryable: true },
      });

      const retriedSummary = await runCauseEffect(fixture.manager.retryConnection(hostId));
      expect(retriedSummary).toMatchObject({ state: "connecting", issue: null });
      expect(fixture.server(hostId)).toMatchObject({ state: "connecting", issue: null });
      expect(JSON.parse(await readFile(fixture.statePath, "utf8")).servers).toContainEqual(
        expect.objectContaining({ id: hostId, encryptedToken: expect.any(String) }),
      );
      expect(createTeamAuthTicket).toHaveBeenCalledTimes(2);
      expect(host.requests("/v1/identity")).toHaveLength(2);
      expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(2);
      expect(JSON.parse(await readFile(fixture.statePath, "utf8")).servers).not.toContainEqual(
        expect.objectContaining({ id: hostId, pendingAccountAuthentication: true }),
      );
    } finally {
      dateNow.mockRestore();
    }
  });

  it("uses one explicit adoption attempt for Retry and replaces the staged metadata with a device session", async () => {
    const hostId = "linux-account-server";
    const apiUrl = "http://100.100.100.107:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    let identityAttempts = 0;
    const host = stubTeamFetch({
      routes: {
        "/v1/identity": ({ url }) => {
          identityAttempts += 1;
          if (identityAttempts === 1) return Response.json({ error: "Host unavailable." }, { status: 503 });
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId: hostId,
            publicKey: publicKeyPem,
            serverName: "Linux server",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        [TEAM_API_ROUTES.auth.account]: () =>
          Response.json({
            member: {
              id: "account-member",
              username: "member",
              email: "person@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "device-session-token",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
      },
    });
    const entry: AccountServerDirectoryEntry = {
      hostId,
      name: "Linux server",
      apiUrl,
      fingerprint: hostFingerprint,
      publicKey: publicKeyPem,
      logoKey: null,
      membershipId: "account-member",
      role: "member",
      isOwner: false,
    };
    const createTeamAuthTicket = vi.fn(() => authCall(async () => "account-ticket"));
    const fixture = await createRemoteManager({
      servers: [],
      account: {
        createTeamAuthTicket,
        getAccountId: () => "account-a",
        getEmail: () => "person@example.com",
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () => authCall(async () => [entry]),
        isSelfHostedSignedIn: () => true,
        registerAccountServer: () => authCall(async () => undefined),
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await runCauseEffect(fixture.manager.syncAccountDirectory());
    expect(fixture.server(hostId)).toMatchObject({ state: "offline", issue: { retryable: true } });
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(0);

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60_000);
    try {
      await runCauseEffect(fixture.manager.retryConnection(hostId));
    } finally {
      dateNow.mockRestore();
    }

    expect(createTeamAuthTicket).toHaveBeenCalledOnce();
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(1);
    expect(fixture.server(hostId)).toMatchObject({ state: "connecting", issue: null });
    expect(JSON.parse(await readFile(fixture.statePath, "utf8")).servers).toContainEqual(
      expect.objectContaining({ id: hostId, encryptedToken: expect.any(String) }),
    );
    expect(JSON.parse(await readFile(fixture.statePath, "utf8")).servers).not.toContainEqual(
      expect.objectContaining({ id: hostId, pendingAccountAuthentication: true }),
    );
  });

  it("keeps the existing device session when the pinned membership is already in the directory", async () => {
    const hostId = "directory-host";
    const createTeamAuthTicket = vi.fn(() => authCall(async () => "account-ticket"));
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          name: "Old name",
          apiUrl: "http://100.100.100.107:43123/",
          fingerprint: "pinned-fingerprint",
          publicKey: "pinned-public-key",
          membershipId: "member-1",
          accountId: "account-a",
          role: "admin",
        }),
      ],
      account: {
        createTeamAuthTicket,
        getAccountId: () => "account-a",
        isSelfHostedSignedIn: () => true,
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () =>
          authCall(async () => [
            {
              hostId,
              name: "New name",
              apiUrl: "http://100.100.100.107:43123/",
              fingerprint: "pinned-fingerprint",
              publicKey: "pinned-public-key",
              logoKey: "logo-2",
              membershipId: "member-1",
              // The production account API deliberately exposes only a member hint; Team auth
              // remains authoritative for the per-device admin role.
              role: "member",
              isOwner: false,
            },
          ]),
        registerAccountServer: () => authCall(async () => undefined),
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(createTeamAuthTicket).not.toHaveBeenCalled();
    expect(fixture.server(hostId)).toMatchObject({ name: "New name", role: "admin" });
  });

  it("renews an existing device session on account sync after the host rejects its token", async () => {
    const hostId = "directory-auth-refresh-host";
    const apiUrl = "http://100.100.100.107:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    let accountLoginAttempts = 0;
    const host = stubTeamFetch({
      compatibility: { capabilities: [] },
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId: hostId,
            publicKey: publicKeyPem,
            serverName: "Account host",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        [TEAM_API_ROUTES.auth.account]: () => {
          accountLoginAttempts += 1;
          if (accountLoginAttempts === 1) return Response.json({ error: "Expired session." }, { status: 401 });
          return Response.json({
            member: {
              id: "member-1",
              username: "member",
              email: "person@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "refreshed-device-session",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        },
        "/v1/remote-screen/capabilities": () =>
          Response.json({ error: "Remote control is unavailable.", code: "host_unavailable" }, { status: 503 }),
      },
    });
    const createTeamAuthTicket = vi.fn(() => authCall(async () => "fresh-account-ticket"));
    const entry: AccountServerDirectoryEntry = {
      hostId,
      name: "Account host",
      apiUrl,
      fingerprint: hostFingerprint,
      publicKey: publicKeyPem,
      logoKey: null,
      membershipId: "member-1",
      role: "member",
      isOwner: false,
    };
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl,
          fingerprint: hostFingerprint,
          publicKey: publicKeyPem,
          membershipId: "member-1",
          accountId: "account-a",
          encryptedToken: Buffer.from("expired-device-session").toString("base64"),
        }),
      ],
      account: {
        createTeamAuthTicket,
        getAccountId: () => "account-a",
        getEmail: () => "person@example.com",
        isSelfHostedSignedIn: () => true,
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () => authCall(async () => [entry]),
        registerAccountServer: () => authCall(async () => undefined),
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await expect(runCauseEffect(fixture.manager.login({ serverId: hostId }))).rejects.toThrow();
    expect(fixture.server(hostId)).toMatchObject({ issue: { code: "authentication_required" } });

    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(createTeamAuthTicket).toHaveBeenCalledTimes(2);
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(2);
    expect(fixture.server(hostId)).toMatchObject({ state: "online", issue: null });
    expect(JSON.parse(await readFile(fixture.statePath, "utf8")).servers).toContainEqual(
      expect.objectContaining({
        id: hostId,
        accountId: "account-a",
        membershipId: "member-1",
        encryptedToken: Buffer.from("refreshed-device-session").toString("base64"),
      }),
    );
  });

  it("rate-limits repeated rejected renewal and resumes it after a transient host outage", async () => {
    const hostId = "directory-auth-refresh-backoff-host";
    const apiUrl = "http://100.100.100.107:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    let accountLoginAttempts = 0;
    const host = stubTeamFetch({
      compatibility: { capabilities: [] },
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId: hostId,
            publicKey: publicKeyPem,
            serverName: "Account host",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        [TEAM_API_ROUTES.auth.account]: () => {
          accountLoginAttempts += 1;
          if (accountLoginAttempts <= 2) return Response.json({ error: "Expired session." }, { status: 401 });
          if (accountLoginAttempts === 3) throw new TypeError("Host is temporarily unreachable.");
          if (accountLoginAttempts === 5) return Response.json({ error: "Expired session." }, { status: 401 });
          if (accountLoginAttempts >= 6)
            return Response.json({ error: "Account ticket is not allowed." }, { status: 403 });
          return Response.json({
            member: {
              id: "member-1",
              username: "member",
              email: "person@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "recovered-device-session",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        },
      },
    });
    const createTeamAuthTicket = vi.fn(() => authCall(async () => "account-ticket"));
    const entry: AccountServerDirectoryEntry = {
      hostId,
      name: "Account host",
      apiUrl,
      fingerprint: hostFingerprint,
      publicKey: publicKeyPem,
      logoKey: null,
      membershipId: "member-1",
      role: "member",
      isOwner: false,
    };
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl,
          fingerprint: hostFingerprint,
          publicKey: publicKeyPem,
          membershipId: "member-1",
          accountId: "account-a",
          encryptedToken: Buffer.from("expired-device-session").toString("base64"),
        }),
      ],
      account: {
        createTeamAuthTicket,
        getAccountId: () => "account-a",
        getEmail: () => "person@example.com",
        isSelfHostedSignedIn: () => true,
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () => authCall(async () => [entry]),
        registerAccountServer: () => authCall(async () => undefined),
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    vi.useFakeTimers();
    await expect(runCauseEffect(fixture.manager.login({ serverId: hostId }))).rejects.toThrow();
    await runCauseEffect(fixture.manager.syncAccountDirectory());
    expect(fixture.server(hostId)).toMatchObject({ issue: { code: "authentication_required" } });
    await runCauseEffect(fixture.manager.syncAccountDirectory());
    expect(createTeamAuthTicket).toHaveBeenCalledTimes(2);
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60_000);
    await runCauseEffect(fixture.manager.syncAccountDirectory());
    expect(fixture.server(hostId)).toMatchObject({ issue: { code: "network_unavailable" } });
    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(createTeamAuthTicket).toHaveBeenCalledTimes(3);
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(60_000);
    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(createTeamAuthTicket).toHaveBeenCalledTimes(4);
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(4);
    expect(fixture.server(hostId)).toMatchObject({ state: "online", issue: null });

    // A later cached-token rejection starts another renewal. If a fresh account ticket then gets a
    // permanent 403, do not let the stale 401 issue put it back into the retry queue.
    await expect(runCauseEffect(fixture.manager.login({ serverId: hostId }))).rejects.toThrow();
    expect(fixture.server(hostId)).toMatchObject({ issue: { code: "authentication_required" } });
    await runCauseEffect(fixture.manager.syncAccountDirectory());
    expect(createTeamAuthTicket).toHaveBeenCalledTimes(6);
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(6);

    await vi.advanceTimersByTimeAsync(60_000);
    await runCauseEffect(fixture.manager.syncAccountDirectory());
    expect(createTeamAuthTicket).toHaveBeenCalledTimes(6);
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(6);
  });

  it("preserves a server selection made while directory reauthentication is in flight", async () => {
    const hostId = "60000000-0000-4000-8000-000000000001";
    const apiUrl = "http://100.100.100.107:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    let authAttempts = 0;
    const host = stubTeamFetch({
      compatibility: { capabilities: [TEAM_MEMBER_DEVICE_LINK_CAPABILITY] },
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId: hostId,
            publicKey: publicKeyPem,
            serverName: "Account host",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        [TEAM_API_ROUTES.auth.account]: () => {
          authAttempts += 1;
          if (authAttempts <= 2) return Response.json({ error: "Expired session." }, { status: 401 });
          return Response.json({
            member: {
              id: "member-1",
              username: "member",
              email: "person@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "refreshed-device-session",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        },
        [TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem]: () =>
          Response.json({
            member: {
              id: "member-1",
              username: "member",
              email: "person@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "joined-device-session",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        "/v1/remote-screen/capabilities": () =>
          Response.json({ error: "Remote control is unavailable.", code: "host_unavailable" }, { status: 503 }),
      },
    });
    let releaseTicket!: () => void;
    let signalTicketRequested!: () => void;
    const ticketGate = new Promise<void>((resolve) => {
      releaseTicket = resolve;
    });
    const ticketRequested = new Promise<void>((resolve) => {
      signalTicketRequested = resolve;
    });
    let ticketCalls = 0;
    const entry: AccountServerDirectoryEntry = {
      hostId,
      name: "Account host",
      apiUrl,
      fingerprint: hostFingerprint,
      publicKey: publicKeyPem,
      logoKey: null,
      membershipId: "member-1",
      role: "member",
      isOwner: false,
    };
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl,
          fingerprint: hostFingerprint,
          publicKey: publicKeyPem,
          membershipId: "member-1",
          accountId: "account-a",
          encryptedToken: Buffer.from("expired-device-session").toString("base64"),
        }),
      ],
      activeServerId: LOCAL_SERVER_ID,
      appVersion: "1.1.0",
      account: {
        createTeamAuthTicket: vi.fn(() =>
          authCall(async () => {
            ticketCalls += 1;
            if (ticketCalls > 1) {
              signalTicketRequested();
              await ticketGate;
            }
            return "account-ticket";
          }),
        ),
        getAccountId: () => "account-a",
        getEmail: () => "person@example.com",
        isSelfHostedSignedIn: () => true,
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () => authCall(async () => [entry]),
        registerAccountServer: () => authCall(async () => undefined),
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await expect(runCauseEffect(fixture.manager.login({ serverId: hostId }))).rejects.toThrow();
    const syncing = runCauseEffect(fixture.manager.syncAccountDirectory());
    await ticketRequested;
    await runCauseEffect(fixture.manager.select(LOCAL_SERVER_ID));
    const inviteUrl = createMemberDeviceLinkUrl(
      { apiUrl, serverId: hostId, fingerprint: hostFingerprint, token: "d".repeat(43) },
      { allowTailscaleApiUrl: true },
    );
    try {
      await runCauseEffect(fixture.manager.join({ inviteUrl }));
    } finally {
      releaseTicket();
    }
    await syncing;

    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(2);
    expect(fixture.manager.activeServerId).toBe(hostId);
    expect(fixture.server(hostId)).toMatchObject({ state: "connecting", issue: null });
    expect(JSON.parse(await readFile(fixture.statePath, "utf8")).servers).toContainEqual(
      expect.objectContaining({
        id: hostId,
        encryptedToken: Buffer.from("joined-device-session").toString("base64"),
      }),
    );
  });

  it("does not requeue an older 401 after a concurrent ticket is permanently refused", async () => {
    const hostId = "60000000-0000-4000-8000-000000000002";
    const apiUrl = "http://100.100.100.107:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = fingerprint(publicKeyPem);
    const pendingRenewal = deferredRoute();
    let accountAttempts = 0;
    const host = stubTeamFetch({
      compatibility: { capabilities: [] },
      routes: {
        "/v1/identity": ({ url }) => {
          const challenge = url.searchParams.get("challenge") ?? "";
          return Response.json({
            serverId: hostId,
            publicKey: publicKeyPem,
            serverName: "Account host",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        },
        [TEAM_API_ROUTES.auth.account]: (call) => {
          accountAttempts += 1;
          if (accountAttempts === 1) return Response.json({ error: "Expired session." }, { status: 401 });
          if (accountAttempts === 2) return pendingRenewal.handler(call);
          if (accountAttempts === 3) return Response.json({ error: "Ticket refused." }, { status: 403 });
          throw new Error("Unexpected account authentication request.");
        },
      },
    });
    const entry: AccountServerDirectoryEntry = {
      hostId,
      name: "Account host",
      apiUrl,
      fingerprint: hostFingerprint,
      publicKey: publicKeyPem,
      logoKey: null,
      membershipId: "member-1",
      role: "member",
      isOwner: false,
    };
    const createTeamAuthTicket = vi.fn(() => authCall(async () => "account-ticket"));
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl,
          fingerprint: hostFingerprint,
          publicKey: publicKeyPem,
          membershipId: "member-1",
          accountId: "account-a",
          encryptedToken: Buffer.from("expired-device-session").toString("base64"),
        }),
      ],
      account: {
        createTeamAuthTicket,
        getAccountId: () => "account-a",
        getEmail: () => "person@example.com",
        isSelfHostedSignedIn: () => true,
        getLegacyAccountServerImportExclusions: () => authCall(async () => []),
        listAccountServers: () => authCall(async () => [entry]),
        registerAccountServer: () => authCall(async () => undefined),
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await expect(runCauseEffect(fixture.manager.login({ serverId: hostId }))).rejects.toThrow();
    const syncing = runCauseEffect(fixture.manager.syncAccountDirectory());
    await pendingRenewal.arrived;
    await expect(runCauseEffect(fixture.manager.login({ serverId: hostId }))).rejects.toThrow();

    pendingRenewal.resolve(Response.json({ error: "Expired session." }, { status: 401 }));
    await syncing;
    expect(fixture.server(hostId)?.issue).toMatchObject({ code: "authentication_required" });

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_000);
    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(createTeamAuthTicket).toHaveBeenCalledTimes(3);
    expect(host.requests(TEAM_API_ROUTES.auth.account)).toHaveLength(3);
  });

  it("does not restore a server removed from the authoritative directory from an old device cache", async () => {
    const hostId = "removed-directory-host";
    const registerAccountServer = vi.fn(() => authCall(async () => undefined));
    const createTeamAuthTicket = vi.fn(() => authCall(async () => "account-ticket"));
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl: "http://100.100.100.107:43123/",
          fingerprint: "pinned-fingerprint",
          publicKey: "pinned-public-key",
          membershipId: "member-1",
          role: "member",
        }),
      ],
      account: {
        createTeamAuthTicket,
        isSelfHostedSignedIn: () => true,
        getLegacyAccountServerImportExclusions: () => authCall(async () => [hostId]),
        listAccountServers: () => authCall(async () => []),
        registerAccountServer,
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await runCauseEffect(fixture.manager.syncAccountDirectory());

    expect(fixture.server(hostId)).toBeUndefined();
    expect(createTeamAuthTicket).not.toHaveBeenCalled();
    expect(registerAccountServer).not.toHaveBeenCalled();
  });

  it("removes a non-owner membership from the signed-in account directory", async () => {
    const hostId = "leave-directory-host";
    const removeAccountServer = vi.fn(() => authCall(async () => undefined));
    const fixture = await createRemoteManager({
      servers: [
        storedHttpsServer(hostId, {
          apiUrl: "http://100.100.100.107:43123/",
          membershipId: "member-1",
          role: "member",
        }),
      ],
      account: {
        createTeamAuthTicket: () => authCall(async () => "account-ticket"),
        getEmail: () => "member@example.com",
        isSelfHostedSignedIn: () => true,
        removeAccountServer,
      },
      managerOptions: { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    });

    await runCauseEffect(fixture.manager.remove(hostId));

    expect(removeAccountServer).toHaveBeenCalledWith(hostId);
    expect(fixture.server(hostId)).toBeUndefined();
  });
});

describe("leaving a remote server", () => {
  // An HTTP host with `member-leave-v1` removes the membership as an admin removal does; an older one
  // can only end this computer's session. A host that fails either must not keep the server listed.
  it("leaves an HTTP host that serves the route, logs out of an older one, also when the host fails", async () => {
    const teamFetch = stubTeamFetch({
      routes: {
        "/v1/compatibility": ({ url }) =>
          Response.json({
            appVersion: "0.4.0",
            protocol: { minimum: 1, maximum: 1 },
            capabilities: url.hostname.startsWith("older") ? [] : ["member-leave-v1"],
          }),
        "/v1/agents": () => Response.json([]),
        "/v1/team/leave": ({ url }) =>
          url.hostname.startsWith("failing")
            ? Response.json({ error: "Host unavailable." }, { status: 503 })
            : new Response(null, { status: 204 }),
        "/v1/auth/logout": () => new Response(null, { status: 204 }),
      },
    });
    const servers = ["current", "older", "failing"];
    const fixture = await createRemoteManager({
      servers: servers.map((id) => storedHttpsServer(id)),
      appVersion: "0.4.0",
    });
    // A request negotiates the protocol first, as the app does before the user can open settings.
    for (const id of servers) await runCauseEffect(fixture.manager.request(id, "/v1/agents", (value) => value));

    for (const id of servers) await runCauseEffect(fixture.manager.remove(id));

    const sent = (path: string) =>
      teamFetch.requests(path).map((call) => [call.url.hostname, call.init?.method, call.headers.get("Authorization")]);
    expect(sent("/v1/team/leave")).toEqual([
      ["current.trycloudflare.com", "POST", "Bearer token-current"],
      ["failing.trycloudflare.com", "POST", "Bearer token-failing"],
    ]);
    expect(sent("/v1/auth/logout")).toEqual([["older.trycloudflare.com", "POST", "Bearer token-older"]]);
    expect(fixture.manager.list().map((server) => server.id)).toEqual(["local"]);
  });
});
