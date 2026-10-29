import {
  createMemberDeviceLinkUrl,
  type InviteLinkPayload,
  isMemberDeviceLinkUrl,
  isTailscaleApiUrl,
  parseInviteUrl,
  parseMemberDeviceLinkUrl,
} from "@openbot/contracts/invite-links";
import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import type { LiveVoiceWireEvent } from "@openbot/contracts/team-protocol/live-voice-v1";
import {
  TEAM_MEMBER_DEVICE_LINK_CAPABILITY,
  TEAM_MEMBER_DEVICE_LINK_ROUTES,
} from "@openbot/contracts/team-protocol/member-device-link-v1";
import { optionalTeamEvent } from "@openbot/contracts/team-protocol/optional-events";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import {
  decodeTeamProtocolSupportV1,
  highestCommonTeamProtocol,
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_V1_WEBSOCKET,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import { encodeTeamProtocolV1CurrentClientEvent } from "@openbot/contracts/team-protocol/v1-adapter";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { TEAM_PROTOCOL_V6 } from "@openbot/contracts/team-protocol/v6";
import { decodeTeamProtocolV6CurrentEventPayload } from "@openbot/contracts/team-protocol/v6-webrtc-adapter";
import { verifyEd25519Pem } from "@openbot/team-client/ed25519";
import type { RemoteInvitePreview } from "@openbot/team-client/remote-directory";
import { remoteHostFingerprint } from "@openbot/team-client/remote-directory";
import type { RemoteFileUpload } from "@openbot/team-client/remote-peer";
import { Effect } from "effect";

export interface LocalTailnetServer {
  hostId: string;
  name: string;
  logoKey: string | null;
  apiUrl: string;
  publicKey: string;
  fingerprint: string;
  sessionToken: string;
  membershipId: string;
  role: "owner" | "admin" | "member";
}

export type TailnetFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type TailnetRandomBytes = (size: number) => Uint8Array;

export type LocalTailnetEvent = AgentEvent | TeamRealtimeEvent | LiveVoiceWireEvent;

export interface LocalTailnetSocketDiagnostic {
  phase: "opening" | "open" | "error" | "close";
  readyState: number;
  protocolAccepted: boolean;
  code?: number;
  wasClean?: boolean;
}

export class DirectTailnetHttpError extends Error {
  constructor(readonly status: number) {
    super(`Tailscale host returned HTTP ${status}.`);
    this.name = "DirectTailnetHttpError";
  }
}

interface IdentityProof {
  serverId: string;
  publicKey: string;
  serverName: string;
  fingerprint: string;
  challenge: string;
  signature: string;
  logoVersion: string | null;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid server identity signature.");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeIdentity(value: unknown): IdentityProof {
  if (
    !isDynamicRecord(value) ||
    !isString(value.serverId) ||
    !isString(value.publicKey) ||
    !isString(value.serverName) ||
    !isString(value.fingerprint) ||
    !isString(value.challenge) ||
    !isString(value.signature) ||
    !(value.logoVersion === null || isString(value.logoVersion))
  ) {
    throw new Error("The Tailscale host returned an invalid identity.");
  }
  return {
    serverId: value.serverId,
    publicKey: value.publicKey,
    serverName: value.serverName,
    fingerprint: value.fingerprint,
    challenge: value.challenge,
    signature: value.signature,
    logoVersion: value.logoVersion,
  };
}

function decodeJoinedMember(value: unknown): {
  membershipId: string;
  role: LocalTailnetServer["role"];
  sessionToken: string;
} {
  if (
    !isDynamicRecord(value) ||
    !isDynamicRecord(value.member) ||
    !isString(value.sessionToken) ||
    !value.sessionToken
  ) {
    throw new Error("The Tailscale host returned an invalid pairing response.");
  }
  const role = value.member.role;
  const membershipId = value.member.id;
  if (!isString(membershipId) || !membershipId || (role !== "owner" && role !== "admin" && role !== "member")) {
    throw new Error("The Tailscale host returned an invalid pairing response.");
  }
  return { membershipId, role, sessionToken: value.sessionToken };
}

async function readJson<T>(response: Response, decode: (value: unknown) => T): Promise<T> {
  const value = await response.json();
  if (!response.ok) {
    const message =
      isDynamicRecord(value) && isString(value.error) ? value.error : `Host request failed (${response.status}).`;
    throw new Error(message);
  }
  return decode(value);
}

async function negotiate(apiUrl: string, fetcher: TailnetFetch) {
  const response = await fetcher(new URL(TEAM_API_ROUTES.compatibility, apiUrl));
  const support = await readJson(response, decodeTeamProtocolSupportV1);
  const protocol = highestCommonTeamProtocol({ minimum: 1, maximum: TEAM_PROTOCOL_V6 }, support.protocol);
  if (protocol === null) throw new Error("The Tailscale host needs a compatible OpenBot update.");
  return { protocol, support };
}

async function requestJson(
  apiUrl: string,
  appVersion: string,
  protocol: number,
  method: string,
  path: string,
  token: string | null,
  body: Record<string, string> | undefined,
  fetcher: TailnetFetch,
): Promise<TeamProtocolV2Json> {
  const headers = new Headers({ Accept: "application/json", [TEAM_PROTOCOL_VERSION_HEADER]: String(protocol) });
  if (appVersion) {
    headers.set(TEAM_APP_VERSION_HEADER, appVersion);
    headers.set(TEAM_CAPABILITIES_HEADER, TEAM_CURRENT_CAPABILITIES.join(","));
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const codec = teamHttpCodec(protocol);
  const sideRoute = teamSideRouteCodec(path);
  const response = await fetcher(new URL(path, apiUrl), {
    method,
    headers,
    ...(body === undefined
      ? {}
      : {
          body: sideRoute
            ? JSON.stringify(sideRoute.request(path, body))
            : codec.encodeRequest(method, path, body, { preserveSemanticTags: true }),
        }),
  });
  return readJson(response, (value) =>
    sideRoute
      ? sideRoute.response(path, response.status, value)
      : codec.decodeResponse(method, path, response.status, value),
  );
}

function randomPassword(randomBytes: TailnetRandomBytes): string {
  return base64Url(randomBytes(32));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function isAttachmentDownloadPath(path: string): boolean {
  return /^\/v1\/attachments\/[^/]+$/u.test(path);
}

function attachmentDownloadName(response: Response, path: string): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded = disposition.match(/(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/gu, ""));
    } catch {
      // A malformed optional filename must not prevent the file bytes from being downloaded.
    }
  }
  const plain = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]+))/iu);
  const name = plain?.[1] ?? plain?.[2]?.trim();
  if (name) return name;
  return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
}

function isAgentAvatarPath(path: string): boolean {
  return /^\/v1\/agents\/[^/]+\/avatar$/u.test(path);
}

export function parseTailnetInvite(value: string): InviteLinkPayload {
  const invite = parseInviteUrl(value, { allowTailscaleApiUrl: true });
  if (!isTailscaleApiUrl(invite.apiUrl)) throw new Error("Only Tailscale host invitations can be used in local mode.");
  return invite;
}

export function parseTailnetMemberDeviceLink(value: string): InviteLinkPayload {
  const link = parseMemberDeviceLinkUrl(value, { allowTailscaleApiUrl: true });
  if (!isTailscaleApiUrl(link.apiUrl)) throw new Error("Only Tailscale device links can be used in local mode.");
  return { apiUrl: link.apiUrl, serverId: link.serverId, fingerprint: link.fingerprint, token: link.token };
}

export function isTailnetMemberDeviceLink(value: string): boolean {
  return (
    isMemberDeviceLinkUrl(value, { allowTailscaleApiUrl: true }) &&
    isTailscaleApiUrl(parseMemberDeviceLinkUrl(value).apiUrl)
  );
}

export function createTailnetMemberDeviceLinkUrl(server: LocalTailnetServer, token: string): string {
  return createMemberDeviceLinkUrl(
    { apiUrl: server.apiUrl, serverId: server.hostId, fingerprint: server.fingerprint, token },
    { allowTailscaleApiUrl: true },
  );
}

export function decodeTailnetMemberDeviceLink(value: unknown): { token: string; expiresAt: string } {
  if (!isDynamicRecord(value) || !isString(value.token) || !isString(value.expiresAt)) {
    throw new Error("The Tailscale host returned an invalid device link.");
  }
  return { token: value.token, expiresAt: value.expiresAt };
}

async function verifyTailnetIdentity(
  invite: InviteLinkPayload,
  appVersion: string,
  fetcher: TailnetFetch,
  randomBytes: TailnetRandomBytes,
): Promise<{ protocol: number; proof: IdentityProof; support: ReturnType<typeof decodeTeamProtocolSupportV1> }> {
  const { protocol, support } = await negotiate(invite.apiUrl, fetcher);
  const challenge = base64Url(randomBytes(24));
  const identityPath = `${TEAM_API_ROUTES.identity}?challenge=${encodeURIComponent(challenge)}`;
  const proof = decodeIdentity(
    await requestJson(invite.apiUrl, appVersion, protocol, "GET", identityPath, null, undefined, fetcher),
  );
  const verified =
    proof.serverId === invite.serverId &&
    proof.challenge === challenge &&
    proof.fingerprint === invite.fingerprint &&
    remoteHostFingerprint(proof.publicKey) === invite.fingerprint &&
    (await Effect.runPromise(
      verifyEd25519Pem(decodeBase64Url(proof.signature), new TextEncoder().encode(challenge), proof.publicKey),
    ));
  if (!verified) throw new Error("The Tailscale host identity could not be verified.");
  return { protocol, proof, support };
}

/** Reviews a local invitation without consuming its one-time token or contacting an account service. */
export async function previewTailnetInvite(
  inviteUrl: string,
  options: { appVersion: string; fetch?: TailnetFetch; randomBytes: TailnetRandomBytes },
): Promise<RemoteInvitePreview> {
  const deviceLink = isTailnetMemberDeviceLink(inviteUrl);
  const invite = deviceLink ? parseTailnetMemberDeviceLink(inviteUrl) : parseTailnetInvite(inviteUrl);
  const { appVersion } = options;
  const fetcher = options.fetch ?? fetch;
  const { randomBytes } = options;
  const { protocol, proof, support } = await verifyTailnetIdentity(invite, appVersion, fetcher, randomBytes);
  if (deviceLink) {
    if (!support.capabilities.includes(TEAM_MEMBER_DEVICE_LINK_CAPABILITY)) {
      throw new Error("The Tailscale host does not support linking member devices. Update the host first.");
    }
    return {
      hostId: proof.serverId,
      hostName: proof.serverName,
      role: "member",
      // The UI uses a dedicated description for these links; this value is intentionally not shown.
      expiresAt: Date.now() + 10 * 60 * 1_000,
      emailBound: false,
      permanent: false,
      devicePublicKey: proof.publicKey,
    };
  }
  const path = TEAM_API_ROUTES.join.invitationPreview;
  const preview = await requestJson(
    invite.apiUrl,
    appVersion,
    protocol,
    "POST",
    path,
    null,
    { inviteToken: invite.token },
    fetcher,
  );
  if (
    !isDynamicRecord(preview) ||
    (preview.role !== "admin" && preview.role !== "member") ||
    !isString(preview.expiresAt) ||
    !Number.isFinite(Date.parse(preview.expiresAt)) ||
    typeof preview.emailBound !== "boolean"
  ) {
    throw new Error("The Tailscale host returned an invalid invitation preview.");
  }
  const expiresAt = Date.parse(preview.expiresAt);
  return {
    hostId: proof.serverId,
    hostName: proof.serverName,
    role: preview.role,
    expiresAt,
    emailBound: preview.emailBound,
    permanent: preview.permanent === true || expiresAt >= 8_640_000_000_000_000,
    devicePublicKey: proof.publicKey,
  };
}

/** Verifies the host's pinned identity before sending the one-time invite token or a password. */
export async function pairTailnetInvite(
  inviteUrl: string,
  options: {
    appVersion: string;
    fetch?: TailnetFetch;
    randomBytes: TailnetRandomBytes;
    displayName?: string | null;
    existingSessionToken?: string | null;
  },
): Promise<LocalTailnetServer> {
  const deviceLink = isTailnetMemberDeviceLink(inviteUrl);
  const invite = deviceLink ? parseTailnetMemberDeviceLink(inviteUrl) : parseTailnetInvite(inviteUrl);
  const fetcher = options.fetch ?? fetch;
  const { appVersion, randomBytes } = options;
  const { protocol, proof, support } = await verifyTailnetIdentity(invite, appVersion, fetcher, randomBytes);

  let joined: ReturnType<typeof decodeJoinedMember>;
  if (deviceLink) {
    if (!support.capabilities.includes(TEAM_MEMBER_DEVICE_LINK_CAPABILITY)) {
      throw new Error("The Tailscale host does not support linking member devices. Update the host first.");
    }
    joined = decodeJoinedMember(
      await requestJson(
        invite.apiUrl,
        appVersion,
        protocol,
        "POST",
        TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem,
        options.existingSessionToken ?? null,
        { token: invite.token },
        fetcher,
      ),
    );
  } else {
    const username = `device-${base64Url(randomBytes(12)).slice(0, 16)}`;
    const password = randomPassword(randomBytes);
    joined = decodeJoinedMember(
      await requestJson(
        invite.apiUrl,
        appVersion,
        protocol,
        "POST",
        TEAM_API_ROUTES.join.server,
        null,
        {
          inviteToken: invite.token,
          username,
          password,
          ...(options.displayName?.trim() ? { displayName: options.displayName.trim() } : {}),
        },
        fetcher,
      ),
    );
  }
  return {
    hostId: proof.serverId,
    name: proof.serverName,
    logoKey: proof.logoVersion,
    apiUrl: invite.apiUrl,
    publicKey: proof.publicKey,
    fingerprint: proof.fingerprint,
    sessionToken: joined.sessionToken,
    membershipId: joined.membershipId,
    role: joined.role,
  };
}

/** Native Android transport for a paired host. It never contacts an account directory or uses WebRTC. */
export class DirectTailnetTeamClient {
  readonly #server: LocalTailnetServer;
  readonly #appVersion: string;
  readonly #fetch: TailnetFetch;
  readonly #randomBytes: TailnetRandomBytes;
  #protocol: number | null = null;
  #capabilities: string[] = [];
  #events: WebSocket | null = null;

  constructor(
    server: LocalTailnetServer,
    options: { appVersion?: string; fetch?: TailnetFetch; randomBytes: TailnetRandomBytes },
  ) {
    this.#server = server;
    this.#appVersion = options.appVersion ?? "";
    this.#fetch = options.fetch ?? fetch;
    this.#randomBytes = options.randomBytes;
  }

  get capabilities(): readonly string[] {
    return this.#capabilities;
  }

  async connect(): Promise<void> {
    const { protocol, support } = await verifyTailnetIdentity(
      {
        apiUrl: this.#server.apiUrl,
        serverId: this.#server.hostId,
        fingerprint: this.#server.fingerprint,
        token: "",
      },
      this.#appVersion,
      this.#fetch,
      this.#randomBytes,
    );
    this.#protocol = protocol;
    this.#capabilities = support.capabilities;
  }

  async request<T>(
    method: string,
    path: string,
    decode: (value: unknown) => T,
    body?: unknown,
    upload?: RemoteFileUpload,
    onUploadProgress?: (fraction: number) => void,
  ): Promise<T> {
    const protocol = this.#protocol;
    if (protocol === null) throw new Error("The Tailscale host is not connected yet.");
    const url = new URL(path, this.#server.apiUrl);
    const route = url.pathname;
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${this.#server.sessionToken}`,
      [TEAM_PROTOCOL_VERSION_HEADER]: String(protocol),
    });
    if (this.#appVersion) {
      headers.set(TEAM_APP_VERSION_HEADER, this.#appVersion);
      headers.set(TEAM_CAPABILITIES_HEADER, TEAM_CURRENT_CAPABILITIES.join(","));
    }
    const sideRoute = teamSideRouteCodec(route);
    let requestBody: BodyInit | undefined;
    if (upload) {
      const binary = atob(upload.base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      headers.set("Content-Type", upload.mimeType);
      requestBody = bytes.buffer;
    } else if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      requestBody = sideRoute
        ? JSON.stringify(sideRoute.request(route, body))
        : teamHttpCodec(protocol).encodeRequest(method, route, body, { preserveSemanticTags: true });
    }
    const response = await this.#fetch(url, {
      method,
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
    });
    const avatarResponse = method === "GET" && response.ok && isAgentAvatarPath(route);
    // Attachments (including 206 byte-range responses) are streamed as raw bytes by the host.
    // Parsing them as JSON yields the Android Unexpected end of input error and prevents both
    // progressive video playback and the download action from receiving their expected envelope.
    const attachmentResponse = method === "GET" && response.ok && isAttachmentDownloadPath(route);
    const value =
      response.status === 204
        ? undefined
        : avatarResponse || attachmentResponse
          ? {
              ...(attachmentResponse ? { name: attachmentDownloadName(response, route) } : {}),
              mimeType: response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() ?? "",
              base64: bytesToBase64(new Uint8Array(await response.arrayBuffer())),
            }
          : await response.json();
    const decoded =
      value === undefined
        ? undefined
        : avatarResponse || attachmentResponse
          ? value
          : sideRoute
            ? sideRoute.response(route, response.status, value)
            : teamHttpCodec(protocol).decodeResponse(method, route, response.status, value);
    if (!response.ok) throw new DirectTailnetHttpError(response.status);
    onUploadProgress?.(1);
    return decode(decoded);
  }

  openEvents(
    onEvent: (event: LocalTailnetEvent) => void,
    onClosed: () => void,
    onDiagnostic: (diagnostic: LocalTailnetSocketDiagnostic) => void = () => {},
  ): Promise<void> {
    const url = new URL(TEAM_API_ROUTES.events, this.#server.apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // React Native's native WebSocket bridge requires a string URL. The browser implementation
    // accepts URL objects, but Android's HostFunction rejects them before the socket can open.
    const socket = new WebSocket(url.toString(), [
      TEAM_PROTOCOL_V1_WEBSOCKET,
      `openbot-token.${this.#server.sessionToken}`,
    ]);
    this.#events = socket;
    const diagnostic = (
      phase: LocalTailnetSocketDiagnostic["phase"],
      details: Pick<LocalTailnetSocketDiagnostic, "code" | "wasClean"> = {},
    ) =>
      onDiagnostic({
        phase,
        readyState: socket.readyState,
        protocolAccepted: socket.protocol === TEAM_PROTOCOL_V1_WEBSOCKET,
        ...details,
      });
    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      let closedNotified = false;
      const notifyClosed = () => {
        if (closedNotified) return;
        closedNotified = true;
        onClosed();
      };
      const rejectBeforeOpen = () => {
        if (settled) return;
        settled = true;
        reject(new Error("The Tailscale event connection failed."));
      };
      diagnostic("opening");
      socket.addEventListener(
        "open",
        () => {
          if (settled) {
            socket.close();
            return;
          }
          opened = true;
          diagnostic("open");
          try {
            socket.send(
              encodeTeamProtocolV1CurrentClientEvent({
                type: "agent-event-scope",
                includeConversations: true,
                capabilities: TEAM_CURRENT_CAPABILITIES,
              }),
            );
            settled = true;
            resolve();
          } catch {
            diagnostic("error");
            settled = true;
            reject(new Error("The Tailscale event connection failed."));
            socket.close();
          }
        },
        { once: true },
      );
      socket.addEventListener("error", () => {
        diagnostic("error");
        if (!opened) {
          rejectBeforeOpen();
          if (socket.readyState < WebSocket.CLOSING) socket.close();
        } else {
          notifyClosed();
          if (socket.readyState < WebSocket.CLOSING) socket.close();
        }
      });
      socket.addEventListener("close", (closed: CloseEvent) => {
        diagnostic("close", { code: closed.code, wasClean: closed.wasClean });
        if (!opened) rejectBeforeOpen();
        else notifyClosed();
      });
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string" || message.data.length > 1024 * 1024) return;
        try {
          const value = JSON.parse(message.data);
          const optional = optionalTeamEvent(value);
          const decoded = optional
            ? { kind: "known" as const, event: optional }
            : decodeTeamProtocolV6CurrentEventPayload(value);
          if (decoded.kind === "known") onEvent(decoded.event);
        } catch {
          // Ignore an unknown or malformed optional event; the next state snapshot repairs it.
        }
      });
    });
  }

  disconnect(): void {
    const socket = this.#events;
    this.#events = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Client disconnected");
    this.#protocol = null;
    this.#capabilities = [];
  }
}
