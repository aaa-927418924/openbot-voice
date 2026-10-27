"use dom";

import type { RemoteDesktopSession } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  decodeRemoteDesktopSignalBinary,
  decodeRemoteDesktopSignalControl,
  encodeRemoteDesktopSignalBinary,
  encodeRemoteDesktopSignalControl,
  type RemoteDesktopSignalControl,
} from "@openbot/contracts/team-protocol/remote-stream-v1";
import {
  createRemoteTeamPeer,
  type RemoteTeamCommand,
  type RemoteTeamCommandResult,
  type RemoteTeamPeerActions,
} from "@openbot/team-client/remote-peer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface RemoteTeamBridgeProps extends RemoteTeamPeerActions {
  commands: RemoteTeamCommand[];
  active: boolean;
  onCommandResult: (result: RemoteTeamCommandResult) => Promise<void>;
  remoteDesktopSession?: RemoteDesktopSession | null;
  directRemoteDesktop?: boolean;
  remoteDesktopLabels?: { back: string; connecting: string; title: string };
  onCloseRemoteDesktop?: (sessionId: string) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}

type RemoteSocketCommand =
  | { type: "open"; streamId: string; path: string }
  | { type: "text"; streamId: string; data: string }
  | { type: "binary"; streamId: string; data: string }
  | { type: "close"; streamId: string; code?: number; reason?: string };
type ViewerSocketMessage =
  | Exclude<RemoteDesktopSignalControl, { type: "open" }>
  | {
      type: "binary";
      streamId: string;
      data: string;
    };

const SOCKET_SOURCE = "openbot-remote-desktop-socket-v1";

function decodeRemoteSocketCommand(value: unknown): RemoteSocketCommand | null {
  if (!isDynamicRecord(value) || value.source !== SOCKET_SOURCE || !isString(value.type) || !isString(value.streamId))
    return null;
  if (value.type === "open" && isString(value.path) && value.path.length <= 2048)
    return { type: "open", streamId: value.streamId, path: value.path };
  if (value.type === "text" && isString(value.data) && value.data.length <= 1024 * 1024)
    return { type: "text", streamId: value.streamId, data: value.data };
  if (value.type === "binary" && isString(value.data) && value.data.length <= 1400000)
    return { type: "binary", streamId: value.streamId, data: value.data };
  if (
    value.type === "close" &&
    (value.code === undefined || (isNumber(value.code) && Number.isInteger(value.code))) &&
    (value.reason === undefined || isString(value.reason))
  ) {
    return {
      type: "close",
      streamId: value.streamId,
      ...(isNumber(value.code) ? { code: value.code } : {}),
      ...(isString(value.reason) ? { reason: value.reason.slice(0, 123) } : {}),
    };
  }
  return null;
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 24576)
    binary += String.fromCharCode(...value.subarray(index, index + 24576));
  return btoa(binary);
}

// Missing in Expo Go on Android until the props come again; see expo-go-dom.ts.
const NO_COMMANDS: RemoteTeamCommand[] = [];

export default function RemoteTeamBridge({
  commands = NO_COMMANDS,
  active,
  onCommandResult,
  remoteDesktopSession = null,
  directRemoteDesktop = false,
  remoteDesktopLabels = { back: "Back", connecting: "Connecting…", title: "Remote desktop" },
  onCloseRemoteDesktop,
  ...callbacks
}: RemoteTeamBridgeProps) {
  const viewerFrame = useRef<HTMLIFrameElement | null>(null);
  const viewerSession = useRef(remoteDesktopSession);
  viewerSession.current = remoteDesktopSession;
  const viewerStreams = useRef(new Set<string>());
  const [viewerState, setViewerState] = useState("connecting");
  const viewerUrl = useMemo(() => {
    if (!remoteDesktopSession) return null;
    const url = new URL(remoteDesktopSession.viewerUrl);
    if (!directRemoteDesktop) url.searchParams.set("openbotRelay", "1");
    else url.searchParams.delete("openbotRelay");
    url.hash = remoteDesktopSession.viewerGrant;
    return url.toString();
  }, [directRemoteDesktop, remoteDesktopSession]);

  const sendViewerMessage = useCallback((message: ViewerSocketMessage) => {
    const session = viewerSession.current;
    const frame = viewerFrame.current?.contentWindow;
    if (!session || !frame) return;
    try {
      frame.postMessage(
        { source: SOCKET_SOURCE, sessionId: session.id, ...message },
        new URL(session.viewerUrl).origin,
      );
    } catch {
      // A viewer can disappear while a final WebRTC frame is being delivered.
    }
  }, []);

  const onHostStreamData = (data: string | ArrayBuffer) => {
    const session = viewerSession.current;
    if (!session) return;
    try {
      if (typeof data === "string") {
        const message = decodeRemoteDesktopSignalControl(data);
        if (message.type === "open" || !viewerStreams.current.has(message.streamId)) return;
        if (message.type === "opened") {
          sendViewerMessage({ type: "opened", streamId: message.streamId });
          setViewerState("connected");
        } else if (message.type === "text") {
          sendViewerMessage({ type: "text", streamId: message.streamId, data: message.data });
        } else if (message.type === "close") {
          sendViewerMessage({
            type: "close",
            streamId: message.streamId,
            ...(message.code !== undefined ? { code: message.code } : {}),
            ...(message.reason ? { reason: message.reason } : {}),
          });
        } else {
          sendViewerMessage({ type: "error", streamId: message.streamId, message: message.message });
        }
        if (message.type === "close" || message.type === "error") viewerStreams.current.delete(message.streamId);
        return;
      }
      const frame = decodeRemoteDesktopSignalBinary(data);
      if (viewerStreams.current.has(frame.streamId))
        sendViewerMessage({ type: "binary", streamId: frame.streamId, data: toBase64(frame.bytes) });
    } catch {
      // Ignore an invalid optional desktop frame without disturbing the Team connection.
    }
  };

  const actions = useRef({ ...callbacks, onHostStreamData });
  actions.current = { ...callbacks, onHostStreamData };
  const runtime = useRef<ReturnType<typeof createRemoteTeamPeer> | null>(null);
  if (!runtime.current) runtime.current = createRemoteTeamPeer(actions);
  const peer = runtime.current;
  const processedCommandIds = useRef(new Set<string>());

  useEffect(() => {
    peer.setActive(active);
  }, [active, peer]);

  // The WebView has no network details, but it sends `online` when the phone gets a network again.
  useEffect(() => {
    const restore = () => peer.networkRestored();
    window.addEventListener("online", restore);
    return () => window.removeEventListener("online", restore);
  }, [peer]);

  useEffect(() => {
    const currentIds = new Set(commands.map((command) => command.id));
    for (const id of processedCommandIds.current) {
      if (!currentIds.has(id)) processedCommandIds.current.delete(id);
    }
    for (const command of commands) {
      if (processedCommandIds.current.has(command.id)) continue;
      processedCommandIds.current.add(command.id);
      void peer.execute(command).then(onCommandResult);
    }
  }, [commands, onCommandResult, peer]);

  useEffect(() => {
    viewerStreams.current.clear();
    setViewerState("connecting");
    if (!remoteDesktopSession) return;
    const origin = new URL(remoteDesktopSession.viewerUrl).origin;
    const streamPath = `${TEAM_API_ROUTES.remoteScreen.session(remoteDesktopSession.id)}/stream`;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== viewerFrame.current?.contentWindow || event.origin !== origin) return;
      if (isDynamicRecord(event.data) && event.data.source === "openbot-moonlight") {
        if (event.data.sessionId === remoteDesktopSession.id && event.data.state === "connected")
          setViewerState("connected");
        if (event.data.sessionId === remoteDesktopSession.id && event.data.state === "error") setViewerState("error");
        return;
      }
      const command = decodeRemoteSocketCommand(event.data);
      if (!command || event.data.sessionId !== remoteDesktopSession.id) return;
      if (command.type === "open") {
        let path: string;
        try {
          const url = new URL(command.path, remoteDesktopSession.viewerUrl);
          if (url.origin !== origin || url.pathname !== streamPath) return;
          path = `${url.pathname}${url.search}`;
        } catch {
          return;
        }
        viewerStreams.current.add(command.streamId);
        void peer
          .sendHostStreamData(encodeRemoteDesktopSignalControl({ type: "open", streamId: command.streamId, path }))
          .catch(() => {
            viewerStreams.current.delete(command.streamId);
            sendViewerMessage({
              type: "error",
              streamId: command.streamId,
              message: "Remote desktop connection failed.",
            });
          });
      } else if (!viewerStreams.current.has(command.streamId)) return;
      else if (command.type === "text") {
        void peer
          .sendHostStreamData(
            encodeRemoteDesktopSignalControl({ type: "text", streamId: command.streamId, data: command.data }),
          )
          .catch(() => undefined);
      } else if (command.type === "binary") {
        try {
          void peer
            .sendHostStreamData(encodeRemoteDesktopSignalBinary(command.streamId, fromBase64(command.data)))
            .catch(() => undefined);
        } catch {
          // Ignore malformed binary input from the isolated viewer frame.
        }
      } else {
        viewerStreams.current.delete(command.streamId);
        void peer
          .sendHostStreamData(
            encodeRemoteDesktopSignalControl({
              type: "close",
              streamId: command.streamId,
              ...(command.code !== undefined ? { code: command.code } : {}),
              ...(command.reason ? { reason: command.reason } : {}),
            }),
          )
          .catch(() => undefined);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      for (const streamId of viewerStreams.current)
        void peer
          .sendHostStreamData(
            encodeRemoteDesktopSignalControl({ type: "close", streamId, code: 1001, reason: "Viewer closed" }),
          )
          .catch(() => undefined);
      viewerStreams.current.clear();
    };
  }, [peer, remoteDesktopSession, sendViewerMessage]);

  useEffect(
    () => () => {
      void peer.dispose();
    },
    [peer],
  );
  if (!remoteDesktopSession || !viewerUrl) return null;
  return (
    <div
      style={{
        alignItems: "stretch",
        background: "#090b0c",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        inset: 0,
        overflow: "hidden",
        position: "fixed",
        width: "100%",
        zIndex: 2147483000,
      }}
    >
      <iframe
        ref={viewerFrame}
        title={remoteDesktopLabels.title}
        src={viewerUrl}
        allow="autoplay; fullscreen; gamepad; clipboard-read; clipboard-write"
        allowFullScreen
        sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"
        style={{ background: "#090b0c", border: 0, flex: 1, height: "100%", width: "100%" }}
      />
      <div
        style={{
          alignItems: "center",
          background: "linear-gradient(180deg, rgba(0,0,0,.55), transparent)",
          display: "flex",
          inset: "0 0 auto",
          justifyContent: "space-between",
          padding: "max(12px, env(safe-area-inset-top)) 16px 22px",
          pointerEvents: "none",
          position: "absolute",
          zIndex: 1,
        }}
      >
        <button
          type="button"
          aria-label={remoteDesktopLabels.back}
          onClick={() => {
            const closing = onCloseRemoteDesktop?.(remoteDesktopSession.id);
            if (closing) void closing.catch(() => setViewerState("error"));
          }}
          style={{
            background: "rgba(26, 26, 26, .9)",
            border: "1px solid rgba(255,255,255,.16)",
            borderRadius: 24,
            color: "#fff",
            font: "600 15px system-ui",
            minHeight: 44,
            padding: "0 16px",
            pointerEvents: "auto",
          }}
        >
          ‹ {remoteDesktopLabels.back}
        </button>
        <span style={{ color: "rgba(255,255,255,.72)", font: "500 12px system-ui" }}>
          {viewerState === "connected" ? remoteDesktopLabels.title : remoteDesktopLabels.connecting}
        </span>
      </div>
    </div>
  );
}
