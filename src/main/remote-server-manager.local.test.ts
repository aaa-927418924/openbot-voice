// @vitest-environment node
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeTeamProtocolV1CurrentHttpResponse } from "@openbot/contracts/team-protocol/v1-adapter";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { RemoteServerManager } from "./remote-server-manager";

class OpenEventSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly url: string;
  readonly protocol: string;
  readyState = 0;

  constructor(url: string | URL, protocols: string[] = []) {
    super();
    this.url = String(url);
    this.protocol = protocols[0] ?? "";
    queueMicrotask(() => {
      this.readyState = OpenEventSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(): void {}

  close(): void {
    this.readyState = OpenEventSocket.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("local-only server directory", () => {
  it("keeps persisted cloud entries but never exposes or reconnects to them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-local-only-directory-"));
    const storePath = join(directory, "servers.json");
    const cloudServerId = "00000000-0000-4000-8000-0000000000c1";
    const tailnetServerId = "00000000-0000-4000-8000-0000000000c2";
    const tailnetApiUrl = "http://100.100.10.2:43123/";
    const initialStore = {
      version: 3,
      activeServerId: cloudServerId,
      servers: [
        {
          id: cloudServerId,
          name: "Old cloud host",
          apiUrl: "https://api.openbot.run/",
          fingerprint: "cloud-fingerprint",
          username: "old-account",
          encryptedToken: Buffer.from("cloud-token").toString("base64"),
          remoteDesktopAvailable: false,
          role: "member",
        },
        {
          id: tailnetServerId,
          name: "Tailnet host",
          apiUrl: tailnetApiUrl,
          fingerprint: "tailnet-fingerprint",
          username: "device-local",
          encryptedToken: Buffer.from("tailnet-token").toString("base64"),
          remoteDesktopAvailable: false,
          role: "member",
        },
      ],
      hiddenHostIds: [],
    };
    await writeFile(storePath, JSON.stringify(initialStore));
    const requests: URL[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      if (url.pathname === "/v1/compatibility") {
        return Response.json({ appVersion: "0.30.0", protocol: { minimum: 1, maximum: 1 }, capabilities: [] });
      }
      if (url.pathname === "/v1/agents") return Response.json([]);
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", OpenEventSocket);
    const manager = new RemoteServerManager(
      storePath,
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      { createTeamAuthTicket: () => Effect.succeed("not used"), getEmail: () => "unused@example.com" },
      { localOnlyNetworking: true, appVersion: "0.30.0", allowTailscaleApiUrl: true },
    );

    try {
      await runCauseEffect(manager.initialize());
      expect(manager.list().map((server) => server.id)).toEqual(["local", tailnetServerId]);
      expect(manager.activeServerId).toBe("local");
      await expect(runCauseEffect(manager.select(cloudServerId))).rejects.toThrow();
      await runCauseEffect(manager.startEventConnections());
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((url) => url.origin === new URL(tailnetApiUrl).origin)).toBe(true);
      expect(JSON.parse(await readFile(storePath, "utf8"))).toMatchObject({
        activeServerId: cloudServerId,
        servers: [{ id: cloudServerId }, { id: tailnetServerId }],
      });
    } finally {
      await runCauseEffect(manager.stop());
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Tailscale-local invitations", () => {
  it("refuses account-service invitation links in local-only mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-local-only-join-"));
    const manager = new RemoteServerManager(
      join(directory, "servers.json"),
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      { createTeamAuthTicket: () => Effect.succeed("not used"), getEmail: () => "unused@example.com" },
      { localOnlyNetworking: true, allowTailscaleApiUrl: true },
    );
    const inviteUrl = new URL("openbot://join");
    inviteUrl.searchParams.set("api", "https://api.openbot.run/");
    inviteUrl.searchParams.set("server", "00000000-0000-4000-8000-0000000000f2");
    inviteUrl.searchParams.set("fingerprint", "a".repeat(43));
    inviteUrl.searchParams.set("invite", "b".repeat(43));

    try {
      await runCauseEffect(manager.initialize());
      await expect(runCauseEffect(manager.previewInvite({ inviteUrl: inviteUrl.toString() }))).rejects.toThrow(
        "Tailscale addresses only",
      );
    } finally {
      await runCauseEffect(manager.stop());
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pairs directly with a tailnet host without requesting a central account ticket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-tailnet-join-"));
    const serverId = "00000000-0000-4000-8000-0000000000f1";
    const apiUrl = "http://100.100.10.2:43123/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const hostFingerprint = createHash("sha256").update(publicKeyPem).digest("base64url");
    let receivedJoinBody: { inviteToken?: unknown; username?: unknown; password?: unknown } | undefined;
    const createTeamAuthTicket = vi.fn(() => Effect.succeed("unexpected-ticket"));
    vi.stubGlobal("WebSocket", OpenEventSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/v1/compatibility")
          return Response.json({ appVersion: "0.30.0", protocol: { minimum: 1, maximum: 1 }, capabilities: [] });
        if (url.pathname === "/v1/identity") {
          const challenge = url.searchParams.get("challenge") ?? "";
          const identity = {
            serverId,
            publicKey: publicKeyPem,
            serverName: "Tailnet host",
            fingerprint: hostFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          };
          return Response.json(
            JSON.parse(encodeTeamProtocolV1CurrentHttpResponse("GET", "/v1/identity", 200, identity)),
          );
        }
        if (url.pathname === "/v1/join") {
          const bodyText = typeof init?.body === "string" ? init.body : "";
          receivedJoinBody = bodyText ? JSON.parse(bodyText) : undefined;
          const result = {
            member: {
              id: "member-id",
              username: "device",
              email: null,
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "local-session-token",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
          return Response.json(JSON.parse(encodeTeamProtocolV1CurrentHttpResponse("POST", "/v1/join", 201, result)), {
            status: 201,
          });
        }
        if (url.pathname === "/v1/remote-screen/capabilities")
          return Response.json(
            JSON.parse(
              encodeTeamProtocolV1CurrentHttpResponse("GET", "/v1/remote-screen/capabilities", 503, {
                error: "Remote control is unavailable.",
                code: "host_unavailable",
              }),
            ),
            { status: 503 },
          );
        if (url.pathname === "/v1/agents")
          return Response.json(JSON.parse(encodeTeamProtocolV1CurrentHttpResponse("GET", "/v1/agents", 200, [])));
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const manager = new RemoteServerManager(
      join(directory, "servers.json"),
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      { createTeamAuthTicket, getEmail: () => "unused@example.com" },
      { allowTailscaleApiUrl: true, appVersion: "0.30.0" },
    );
    const inviteUrl = new URL("openbot://join");
    inviteUrl.searchParams.set("api", apiUrl);
    inviteUrl.searchParams.set("server", serverId);
    inviteUrl.searchParams.set("fingerprint", hostFingerprint);
    inviteUrl.searchParams.set("invite", "b".repeat(43));

    try {
      await runCauseEffect(manager.initialize());
      await expect(runCauseEffect(manager.join({ inviteUrl: inviteUrl.toString() }))).resolves.toMatchObject({
        id: serverId,
        state: "online",
        remoteDesktopAvailable: false,
      });
      expect(createTeamAuthTicket).not.toHaveBeenCalled();
      expect(receivedJoinBody).toMatchObject({ inviteToken: "b".repeat(43) });
      expect(receivedJoinBody?.username).toEqual(expect.stringMatching(/^device-[a-f0-9]{16}$/u));
      expect(receivedJoinBody?.password).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u));
    } finally {
      await runCauseEffect(manager.stop());
      await rm(directory, { recursive: true, force: true });
    }
  });
});
