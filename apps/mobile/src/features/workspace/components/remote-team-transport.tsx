import type { AccountServerDirectoryEntry } from "@openbot/contracts/account-server-directory";
import type { AgentEvent, RemoteDesktopSession, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { LIVE_VOICE_CHANNEL_START_ROUTE } from "@openbot/contracts/team-protocol/live-voice-channel-v1";
import { LIVE_VOICE_ROUTES, type LiveVoiceWireEvent } from "@openbot/contracts/team-protocol/live-voice-v1";
import { isQueueEditRoute, QueueEditRejectedError } from "@openbot/contracts/team-protocol/queue-edit-v1";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { sourceText } from "@openbot/i18n/source";
import type { RemoteTeamDirectoryClient } from "@openbot/team-client";
import { runTeamEffect } from "@openbot/team-client";
import {
  createRemoteCommandMailbox,
  type RemoteFileUpload,
  type RemoteTeamCommand,
  type RemoteTeamCommandResult,
  type RemoteTeamConnectionUpdate,
  type RemoteTeamDiagnostic,
  type RemoteUploadProgress,
  remoteTeamRequestTimeoutMs,
} from "@openbot/team-client/remote-peer";
import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { MobileSession } from "@/features/auth/api/mobile-auth";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { supportLog, supportLogUrl } from "@/features/support/model/support-log";
import {
  DirectTailnetTeamClient,
  type LocalTailnetServer,
  type LocalTailnetSocketDiagnostic,
  loginTailnetAccountServer,
} from "@/features/workspace/model/local-tailnet";
import { saveLocalTailnetServer } from "@/features/workspace/model/local-tailnet-store";
import { expoGoDomOptions } from "@/shared/lib/expo-go-dom";
import { currentText } from "@/shared/lib/text";

import RemoteTeamBridge from "./remote-team-bridge.dom";

export interface RemoteTeamTransportRef {
  connect(hostId: string, hostPublicKey: string): Promise<void>;
  disconnect(): Promise<void>;
  request<T>(
    method: string,
    path: string,
    decode: (value: unknown) => T,
    body?: TeamProtocolV2Json,
    upload?: RemoteFileUpload,
    /** Hears the fraction of the uploaded file sent so far, from 0 to 1. */
    onUploadProgress?: (fraction: number) => void,
  ): Promise<T>;
}

interface RemoteTeamTransportProps {
  active: boolean;
  localTailnetServer?: LocalTailnetServer;
  accountServer?: AccountServerDirectoryEntry;
  onAccountServerPaired?(host: LocalTailnetServer): void;
  remoteDesktopSession?: RemoteDesktopSession | null;
  onCloseRemoteDesktop?: (sessionId: string) => Promise<void>;
  directory: RemoteTeamDirectoryClient | null;
  onConnectionUpdate: (update: RemoteTeamConnectionUpdate) => void;
  /** Signal says this account's server list changed on another device. */
  onMembershipChanged?: () => Promise<void>;
  /** The phone got a network again. */
  onNetworkRestored?: () => void;
  onTeamEvent: (hostId: string, event: AgentEvent | TeamRealtimeEvent | LiveVoiceWireEvent) => void;
}

type RemoteTeamCommandInput =
  | { type: "connect"; hostId: string; hostPublicKey: string }
  | { type: "disconnect" }
  | { type: "request"; method: string; path: string; body: TeamProtocolV2Json; upload?: RemoteFileUpload };

/** Carries an HTTP status without retaining the remote response body or error text. */
export class RemoteTeamHttpError extends Error {
  constructor(readonly status: number) {
    super(`Remote server returned HTTP ${status}.`);
    this.name = "RemoteTeamHttpError";
  }
}

function isLiveVoiceRoute(path: string): boolean {
  return (
    path === LIVE_VOICE_ROUTES.start ||
    path === LIVE_VOICE_ROUTES.stop ||
    path === LIVE_VOICE_ROUTES.sendText ||
    path === LIVE_VOICE_CHANNEL_START_ROUTE
  );
}

function isPairingAuthorizedForSession(server: Pick<LocalTailnetServer, "accountId">, session: MobileSession | null) {
  if (!session?.localOnly) return false;
  return session.sessionToken ? server.accountId === session.user.id : server.accountId === undefined;
}

function matchesAccountServer(server: LocalTailnetServer, accountServer: AccountServerDirectoryEntry): boolean {
  return (
    server.hostId === accountServer.hostId &&
    server.apiUrl === accountServer.apiUrl &&
    server.publicKey === accountServer.publicKey &&
    server.fingerprint === accountServer.fingerprint &&
    server.membershipId === accountServer.membershipId
  );
}

function isPairingCurrent(
  server: LocalTailnetServer,
  context: {
    session: MobileSession | null;
    localTailnetServer?: LocalTailnetServer;
    accountServer?: AccountServerDirectoryEntry;
  },
): boolean {
  if (!isPairingAuthorizedForSession(server, context.session)) return false;
  // The account directory is authoritative for the signed-in account. A device-local pairing can
  // be stale while a fresh host-bound ticket is being redeemed; it must not override that current
  // membership and send the connection through the hosted WebRTC bootstrap path.
  if (context.accountServer?.hostId === server.hostId) return matchesAccountServer(server, context.accountServer);
  if (context.localTailnetServer?.hostId === server.hostId) {
    return (
      context.localTailnetServer.accountId === server.accountId &&
      context.localTailnetServer.apiUrl === server.apiUrl &&
      context.localTailnetServer.publicKey === server.publicKey &&
      context.localTailnetServer.fingerprint === server.fingerprint &&
      context.localTailnetServer.membershipId === server.membershipId
    );
  }
  return Boolean(context.accountServer && matchesAccountServer(server, context.accountServer));
}

export const RemoteTeamTransport = forwardRef<RemoteTeamTransportRef, RemoteTeamTransportProps>(
  function RemoteTeamTransport(
    {
      active: foreground,
      localTailnetServer,
      accountServer,
      onAccountServerPaired,
      remoteDesktopSession = null,
      onCloseRemoteDesktop,
      directory,
      onConnectionUpdate,
      onMembershipChanged,
      onNetworkRestored,
      onTeamEvent,
    },
    ref,
  ) {
    const { session, refreshProfile } = useMobileSession();
    const [commands, setCommands] = useState<RemoteTeamCommand[]>([]);
    const mailboxRef = useRef<ReturnType<typeof createRemoteCommandMailbox> | null>(null);
    if (!mailboxRef.current) mailboxRef.current = createRemoteCommandMailbox(setCommands);
    const mailbox = mailboxRef.current;
    // The server of this transport, for support log lines. Requests do not name it.
    const hostIdRef = useRef<string | null>(null);
    const directClient = useRef<DirectTailnetTeamClient | null>(null);
    const connectedPairing = useRef<LocalTailnetServer | null>(null);
    const authContext = useRef({ session, localTailnetServer, accountServer });
    authContext.current = { session, localTailnetServer, accountServer };
    const directServer = useRef<LocalTailnetServer | null>(localTailnetServer ?? null);
    // Never retain a device-wide cached Team token after the account directory stops confirming
    // that this exact membership belongs to the signed-in account.
    directServer.current = localTailnetServer ?? null;
    const directGeneration = useRef(0);
    const callbacks = useRef({ onConnectionUpdate, onTeamEvent });
    callbacks.current = { onConnectionUpdate, onTeamEvent };
    useEffect(() => () => mailbox.dispose(), [mailbox]);
    useEffect(
      () => () => {
        directGeneration.current += 1;
        directClient.current?.disconnect();
        directClient.current = null;
        connectedPairing.current = null;
      },
      [],
    );

    useEffect(() => {
      const connected = connectedPairing.current;
      if (!connected || !directClient.current) return;

      const stillTrusted = isPairingCurrent(connected, { session, localTailnetServer, accountServer });
      if (stillTrusted) return;

      directGeneration.current += 1;
      directClient.current.disconnect();
      directClient.current = null;
      connectedPairing.current = null;
      callbacks.current.onConnectionUpdate({
        hostId: connected.hostId,
        state: "offline",
        message: sourceText("error.remote.desktopOffline"),
      });
    }, [accountServer, localTailnetServer, session]);

    // Upload progress arrives from the web view by command ID, while the command is still pending.
    const uploadListeners = useRef(new Map<string, (fraction: number) => void>());
    const enqueue = useCallback(
      (
        next: RemoteTeamCommandInput,
        onUploadProgress?: (fraction: number) => void,
        timeoutMs?: number,
      ): Promise<RemoteTeamCommandResult> => {
        const id = Crypto.randomUUID();
        const command: RemoteTeamCommand =
          next.type === "connect"
            ? { id, type: "connect", hostId: next.hostId, hostPublicKey: next.hostPublicKey }
            : next.type === "request"
              ? { id, type: "request", method: next.method, path: next.path, body: next.body, upload: next.upload }
              : { id, type: "disconnect" };
        if (!onUploadProgress) return mailbox.send(command, timeoutMs);
        uploadListeners.current.set(id, onUploadProgress);
        return mailbox.send(command, timeoutMs).finally(() => uploadListeners.current.delete(id));
      },
      [mailbox],
    );

    useImperativeHandle(
      ref,
      () => ({
        connect: async (hostId, hostPublicKey) => {
          const generation = ++directGeneration.current;
          directClient.current?.disconnect();
          directClient.current = null;
          connectedPairing.current = null;
          hostIdRef.current = hostId;
          const initialAuth = authContext.current;
          const connectSession = initialAuth.session;
          const initialAccountServer = initialAuth.accountServer;
          // A cached pairing proves which account and membership this device used, but its Team
          // session token is device-local and may have expired while the account directory stayed
          // current. Prefer a new host-bound ticket whenever this host is present in the signed-in
          // account directory; never fall back to the stale token if fresh redemption fails.
          let server: LocalTailnetServer | null = null;
          if (initialAccountServer?.hostId === hostId && connectSession?.localOnly && connectSession.sessionToken) {
            callbacks.current.onConnectionUpdate({ hostId, state: "connecting", message: null });
            const pairedServer = await loginTailnetAccountServer(initialAccountServer, {
              appVersion: Application.nativeApplicationVersion ?? "",
              randomBytes: (size) => Crypto.getRandomBytes(size),
              accountId: connectSession.user.id,
              identitySession: { apiUrl: connectSession.apiUrl, sessionToken: connectSession.sessionToken },
            });
            if (generation !== directGeneration.current) return;
            let currentAuth = authContext.current;
            const stillCurrentAccount =
              currentAuth.session?.localOnly === true &&
              currentAuth.session.sessionToken.length > 0 &&
              currentAuth.session.user.id === connectSession.user.id &&
              currentAuth.session.apiUrl === connectSession.apiUrl &&
              currentAuth.accountServer !== undefined &&
              matchesAccountServer(pairedServer, currentAuth.accountServer) &&
              isPairingAuthorizedForSession(pairedServer, currentAuth.session);
            if (!stillCurrentAccount) {
              callbacks.current.onConnectionUpdate({
                hostId,
                state: "offline",
                message: sourceText("error.remote.desktopOffline"),
              });
              return;
            }
            await saveLocalTailnetServer(pairedServer);
            if (generation !== directGeneration.current) return;
            currentAuth = authContext.current;
            if (
              !currentAuth.session?.localOnly ||
              !currentAuth.session.sessionToken ||
              currentAuth.session.user.id !== connectSession.user.id ||
              currentAuth.session.apiUrl !== connectSession.apiUrl ||
              !currentAuth.accountServer ||
              !matchesAccountServer(pairedServer, currentAuth.accountServer) ||
              !isPairingAuthorizedForSession(pairedServer, currentAuth.session)
            ) {
              callbacks.current.onConnectionUpdate({
                hostId,
                state: "offline",
                message: sourceText("error.remote.desktopOffline"),
              });
              return;
            }
            server = pairedServer;
            directServer.current = server;
            onAccountServerPaired?.(server);
          } else if (
            initialAuth.localTailnetServer?.hostId === hostId &&
            isPairingAuthorizedForSession(initialAuth.localTailnetServer, connectSession)
          ) {
            server = initialAuth.localTailnetServer;
          }
          if (generation !== directGeneration.current) return;
          if (server?.hostId === hostId && isPairingCurrent(server, authContext.current)) {
            const client = new DirectTailnetTeamClient(server, {
              appVersion: Application.nativeApplicationVersion ?? "",
              randomBytes: (size) => Crypto.getRandomBytes(size),
            });
            directClient.current = client;
            connectedPairing.current = server;
            callbacks.current.onConnectionUpdate({ hostId, state: "connecting", message: null });
            try {
              await client.connect();
              if (
                generation !== directGeneration.current ||
                directClient.current !== client ||
                !isPairingCurrent(server, authContext.current)
              ) {
                if (directClient.current === client) {
                  directClient.current = null;
                  connectedPairing.current = null;
                  client.disconnect();
                }
                return;
              }
              await client.openEvents(
                (event) => callbacks.current.onTeamEvent(hostId, event),
                () => {
                  if (generation !== directGeneration.current || directClient.current !== client) return;
                  directClient.current = null;
                  connectedPairing.current = null;
                  callbacks.current.onConnectionUpdate({
                    hostId,
                    state: "offline",
                    message: sourceText("error.remote.desktopOffline"),
                  });
                },
                (diagnostic: LocalTailnetSocketDiagnostic) => {
                  const closeDetails =
                    diagnostic.phase === "close"
                      ? ` code=${diagnostic.code ?? "unknown"} clean=${diagnostic.wasClean === true}`
                      : "";
                  const severity =
                    diagnostic.phase === "error" || (diagnostic.phase === "close" && diagnostic.code !== 1000)
                      ? "warn"
                      : "info";
                  supportLog.add(
                    severity,
                    "connection",
                    `${hostId} direct event socket ${diagnostic.phase} readyState=${diagnostic.readyState} protocol=${diagnostic.protocolAccepted ? "accepted" : "not-accepted"}${closeDetails}`,
                  );
                },
              );
              if (generation === directGeneration.current && directClient.current === client)
                callbacks.current.onConnectionUpdate({ hostId, state: "online", message: null });
            } catch (error) {
              client.disconnect();
              if (generation === directGeneration.current && directClient.current === client) {
                directClient.current = null;
                connectedPairing.current = null;
                callbacks.current.onConnectionUpdate({
                  hostId,
                  state: "offline",
                  message: sourceText("error.remote.serverRequestFailed"),
                });
              }
              throw error;
            }
            return;
          }
          const result = await enqueue({ type: "connect", hostId, hostPublicKey });
          if (!result.ok) throw new Error(result.error ?? currentText().t("mobile.workspace.error.connectFailed"));
        },
        disconnect: async () => {
          if (directServer.current) {
            directGeneration.current += 1;
            directClient.current?.disconnect();
            directClient.current = null;
            connectedPairing.current = null;
            return;
          }
          const result = await enqueue({ type: "disconnect" });
          if (!result.ok) throw new Error(result.error ?? currentText().t("mobile.workspace.error.disconnectFailed"));
        },
        request: async <T,>(
          method: string,
          path: string,
          decode: (value: unknown) => T,
          body?: TeamProtocolV2Json,
          upload?: RemoteFileUpload,
          onUploadProgress?: (fraction: number) => void,
        ): Promise<T> => {
          const started = Date.now();
          const innerTimeout = remoteTeamRequestTimeoutMs(method, path);
          if (directServer.current) {
            const client = directClient.current;
            if (!client) throw new Error(currentText().t("mobile.workspace.error.transportNotReady"));
            const request = `${hostIdRef.current ?? "unknown server"} ${method} ${supportLogUrl(path)}`;
            try {
              const value = await client.request(method, path, decode, body, upload, onUploadProgress);
              supportLog.add("info", "connection", `${request} -> 200 (${Date.now() - started} ms)`);
              return value;
            } catch (error) {
              const status =
                typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
              supportLog.add(
                "warn",
                "connection",
                `${request} -> ${typeof status === "number" ? status : "failed"} (${Date.now() - started} ms)`,
              );
              if (isLiveVoiceRoute(path) && typeof status === "number" && status >= 400 && status < 500)
                throw new RemoteTeamHttpError(status);
              throw error;
            }
          }
          // Let the peer's route timer return a useful error first. This native timer also recovers
          // if Android's hidden DOM WebView stops processing commands altogether.
          const bridgeTimeout = innerTimeout === undefined ? undefined : innerTimeout + 5_000;
          const result = await enqueue(
            { type: "request", method, path, body: body ?? {}, upload },
            onUploadProgress,
            bridgeTimeout,
          );
          const liveVoiceRoute = isLiveVoiceRoute(path);
          // Method, path, status and time only. Never the body or the upload.
          const request = `${hostIdRef.current ?? "unknown server"} ${method} ${supportLogUrl(path)}`;
          const time = `(${Date.now() - started} ms)`;
          if (!result.ok) {
            const failure = liveVoiceRoute ? "failed" : `failed: ${result.error ?? "no error"}`;
            supportLog.add("warn", "connection", `${request} -> ${failure} ${time}`);
          } else
            supportLog.add(
              result.status !== undefined && result.status >= 400 ? "warn" : "info",
              "connection",
              `${request} -> ${result.status ?? "no status"} ${time}`,
            );
          if (!result.ok) {
            if (liveVoiceRoute && result.status !== undefined && result.status >= 400 && result.status < 500)
              throw new RemoteTeamHttpError(result.status);
            throw new Error(
              liveVoiceRoute
                ? sourceText("error.remote.serverRequestFailed")
                : (result.error ?? sourceText("error.remote.serverRequestFailed")),
            );
          }
          if (result.status === 409 && isQueueEditRoute(method, path))
            throw new QueueEditRejectedError(currentText().t("mobile.workspace.error.queueEditRejected"));
          if (result.status !== undefined && result.status >= 400) {
            if (liveVoiceRoute) throw new RemoteTeamHttpError(result.status);
            throw new Error(sourceText("error.remote.serverRequestFailed"));
          }
          return decode(result.body);
        },
      }),
      [enqueue, onAccountServerPaired],
    );

    const handleCommandResult = useCallback(
      async (result: RemoteTeamCommandResult) => {
        mailbox.receive(result);
      },
      [mailbox],
    );

    const requireDirectory = useCallback((): RemoteTeamDirectoryClient => {
      if (!directory) throw new Error("Account directory is unavailable in local-only mode.");
      return directory;
    }, [directory]);

    return (
      <RemoteTeamBridge
        active={foreground}
        commands={commands}
        remoteDesktopSession={remoteDesktopSession}
        directRemoteDesktop={Boolean(
          directServer.current && hostIdRef.current && directServer.current.hostId === hostIdRef.current,
        )}
        remoteDesktopBaseUrl={accountServer?.hostId === hostIdRef.current ? accountServer.apiUrl : undefined}
        remoteDesktopLabels={{
          back: currentText().t("mobile.remoteDesktop.back"),
          connecting: currentText().t("mobile.remoteDesktop.connecting"),
          title: currentText().t("mobile.remoteDesktop.viewerTitle"),
        }}
        onCloseRemoteDesktop={(sessionId) => onCloseRemoteDesktop?.(sessionId) ?? Promise.resolve()}
        dom={{
          ...expoGoDomOptions,
          containerStyle: remoteDesktopSession
            ? { bottom: 0, elevation: 1000, left: 0, position: "absolute", right: 0, top: 0, zIndex: 1000 }
            : {
                flex: 0,
                height: 1,
                left: 0,
                opacity: 0,
                position: "absolute",
                top: 0,
                width: 1,
              },
          pointerEvents: remoteDesktopSession ? "auto" : "none",
          scrollEnabled: false,
          style: remoteDesktopSession ? { flex: 1, height: "100%", width: "100%" } : { flex: 0, height: 1, width: 1 },
        }}
        endSession={(sessionId) => runTeamEffect(requireDirectory().endSession(sessionId))}
        getBootstrap={(hostId, clientPublicKey, existingSessionId) =>
          runTeamEffect(requireDirectory().createBootstrap(hostId, clientPublicKey, existingSessionId))
        }
        onCommandResult={handleCommandResult}
        onUploadProgress={async ({ commandId, sent, total }: RemoteUploadProgress) =>
          uploadListeners.current.get(commandId)?.(total > 0 ? sent / total : 1)
        }
        onAccountProfileChanged={refreshProfile}
        onAccountServersChanged={onMembershipChanged}
        onConnectionUpdate={async (update) => onConnectionUpdate(update)}
        onDiagnostic={async ({ hostId, step, detail }: RemoteTeamDiagnostic) =>
          supportLog.add(
            step === "failed" ? "warn" : "info",
            "connection",
            `${hostId} peer ${step}${detail ? `: ${detail}` : ""}`,
          )
        }
        onNetworkRestored={async () => onNetworkRestored?.()}
        onTeamEvent={async (hostId, event) => onTeamEvent(hostId, event)}
      />
    );
  },
);
