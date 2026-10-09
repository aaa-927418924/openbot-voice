import * as Crypto from "expo-crypto";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform, View } from "react-native";
import { supportLog } from "@/features/support/model/support-log";
import { androidReactNativeDomOptions } from "@/shared/lib/expo-go-dom";
import { useAppForeground } from "@/shared/lib/use-app-foreground";
import LiveVoiceBridge from "../components/live-voice-bridge.dom";
import {
  EMPTY_LIVE_VOICE_STATE,
  isCurrentLiveVoiceStartAction,
  isLiveVoiceBusy,
  type MobileLiveVoiceOrigin,
  type MobileLiveVoiceState,
  type MobileLiveVoiceTarget,
  matchesLiveVoiceHostEvent,
  routesComposerToLiveVoice,
} from "../model/live-voice";
import {
  createMobileLiveVoiceCommandMailbox,
  type MobileLiveVoiceCommand,
  type MobileLiveVoiceCommandResult,
} from "../model/live-voice-command";
import {
  formatLiveVoiceDomDiagnostic,
  isLiveVoiceDomDiagnosticWarning,
  LIVE_VOICE_DIAGNOSTIC_BUILD_ID,
  LIVE_VOICE_DOM_DIAGNOSTIC_TYPE,
  parseLiveVoiceDomDiagnostic,
} from "../model/live-voice-dom-diagnostic";
import { isMobileLiveVoiceStartRejectedError, type MobileLiveVoiceHost } from "../model/live-voice-host";
import type {
  LiveVoiceDiagnostic,
  LiveVoiceSendTextRequest,
  LiveVoiceStartActionResult,
  LiveVoiceStartRequest,
  LiveVoiceStopRequest,
} from "../model/live-voice-web-controller";

interface MobileLiveVoiceContextValue {
  state: MobileLiveVoiceState;
  origin: MobileLiveVoiceOrigin | null;
  canStart(target: MobileLiveVoiceTarget): boolean;
  start(target: MobileLiveVoiceTarget): void;
  stop(): void;
  toggleMute(): void;
  resumeAudio(): void;
  sendText(text: string): Promise<void>;
  routesComposer(target: Pick<MobileLiveVoiceTarget, "serverId" | "agentId" | "threadId" | "channelId">): boolean;
}

const MobileLiveVoiceContext = createContext<MobileLiveVoiceContextValue | null>(null);

type ServerSummary = { id: string; state: string };

export function MobileLiveVoiceProvider({
  children,
  host,
  activeServerId,
  servers,
}: PropsWithChildren<{
  host: MobileLiveVoiceHost;
  activeServerId: string;
  servers: ServerSummary[];
}>) {
  const foreground = useAppForeground();
  const [state, setState] = useState(EMPTY_LIVE_VOICE_STATE);
  const [origin, setOrigin] = useState<MobileLiveVoiceOrigin | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const originRef = useRef(origin);
  originRef.current = origin;
  const actionContextRef = useRef({ activeServerId, foreground, servers });
  actionContextRef.current = { activeServerId, foreground, servers };
  const hostRef = useRef(host);
  hostRef.current = host;
  const mountedRef = useRef(true);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [commands, setCommands] = useState<MobileLiveVoiceCommand[]>([]);
  const mailboxRef = useRef<ReturnType<typeof createMobileLiveVoiceCommandMailbox> | null>(null);
  if (!mailboxRef.current) mailboxRef.current = createMobileLiveVoiceCommandMailbox(setCommands);
  const mailbox = mailboxRef.current;

  const publish = useCallback((next: MobileLiveVoiceState) => {
    stateRef.current = next;
    setState(next);
    if (next.phase === "idle" && !next.hostSessionActive) {
      originRef.current = null;
      setOrigin(null);
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = undefined;
      return;
    }
    if (next.phase === "error" && !next.hostSessionActive) {
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => {
        if (stateRef.current.sessionId !== next.sessionId || stateRef.current.hostSessionActive) return;
        originRef.current = null;
        setOrigin(null);
        publish(EMPTY_LIVE_VOICE_STATE);
      }, 5_000);
    }
  }, []);

  const canStart = useCallback(
    (target: MobileLiveVoiceTarget) =>
      foreground &&
      target.serverId === activeServerId &&
      servers.some((server) => server.id === target.serverId && server.state === "online") &&
      hostRef.current.supportsLiveVoice(target.serverId, Boolean(target.channelId)) &&
      !isLiveVoiceBusy(stateRef.current),
    [activeServerId, foreground, servers],
  );

  const start = useCallback(
    (target: MobileLiveVoiceTarget) => {
      if (!canStart(target)) return;
      supportLog.add(
        "info",
        "connection",
        `Live Voice probe [${LIVE_VOICE_DIAGNOSTIC_BUILD_ID}]: native start accepted`,
      );
      const nextOrigin = { target, sessionId: Crypto.randomUUID() };
      originRef.current = nextOrigin;
      setOrigin(nextOrigin);
      publish({
        ...EMPTY_LIVE_VOICE_STATE,
        phase: "connecting",
        sessionId: nextOrigin.sessionId,
      });
      const command: MobileLiveVoiceCommand = {
        id: Crypto.randomUUID(),
        type: "start",
        origin: nextOrigin,
      };
      void mailbox.send(command).then((result) => {
        supportLog.add(
          "info",
          "connection",
          `Live Voice probe [${LIVE_VOICE_DIAGNOSTIC_BUILD_ID}]: command ${result.ok ? "acknowledged" : (result.error ?? "failed")}`,
        );
        if (result.ok || originRef.current?.sessionId !== nextOrigin.sessionId) return;
        if (result.error === "timeout") {
          // Best effort: the bridge may have started the provider request before its reply stalled.
          void mailbox.send({ id: Crypto.randomUUID(), type: "stop" });
        }
        if (stateRef.current.phase === "stopping") return;
        if (stateRef.current.hostSessionActive) return;
        publish({
          ...EMPTY_LIVE_VOICE_STATE,
          phase: "error",
          sessionId: nextOrigin.sessionId,
          error: "unavailable",
        });
      });
    },
    [canStart, mailbox, publish],
  );

  const stop = useCallback(() => {
    const current = originRef.current;
    if (!current || !isLiveVoiceBusy(stateRef.current) || stateRef.current.phase === "stopping") return;
    publish({ ...stateRef.current, phase: "stopping" });
    void mailbox.send({ id: Crypto.randomUUID(), type: "stop" }).then((result) => {
      if (originRef.current?.sessionId !== current.sessionId) return;
      if (result.ok && !stateRef.current.hostSessionActive) publish(EMPTY_LIVE_VOICE_STATE);
      else if (!result.ok && stateRef.current.hostSessionActive)
        publish({ ...stateRef.current, phase: "error", error: "stop" });
      else if (!result.ok) publish(EMPTY_LIVE_VOICE_STATE);
    });
  }, [mailbox, publish]);

  const toggleMute = useCallback(() => {
    if (!originRef.current || !isLiveVoiceBusy(stateRef.current)) return;
    void mailbox.send({ id: Crypto.randomUUID(), type: "toggle-mute" });
  }, [mailbox]);

  const resumeAudio = useCallback(() => {
    if (!originRef.current || !isLiveVoiceBusy(stateRef.current)) return;
    void mailbox.send({ id: Crypto.randomUUID(), type: "resume-audio" });
  }, [mailbox]);

  const sendText = useCallback(
    async (text: string) => {
      if (!originRef.current || stateRef.current.phase !== "live" || !stateRef.current.hostSessionActive)
        throw new Error("unavailable");
      const result = await mailbox.send({ id: Crypto.randomUUID(), type: "send-text", text });
      if (!result.ok) throw new Error("unavailable");
    },
    [mailbox],
  );

  const onBridgeState = useCallback(
    async (next: MobileLiveVoiceState) => {
      if (originRef.current?.sessionId !== next.sessionId) return;
      publish(next);
    },
    [publish],
  );

  const onBridgeDiagnostic = useCallback(async ({ step, outcome, elapsedMs }: LiveVoiceDiagnostic) => {
    const level = ["failed", "timeout", "rejected", "permission-denied", "unsupported"].includes(outcome)
      ? "warn"
      : "info";
    supportLog.add(
      level,
      "connection",
      `Live Voice probe [${LIVE_VOICE_DIAGNOSTIC_BUILD_ID}]: ${step}: ${outcome} (${elapsedMs} ms)`,
    );
  }, []);

  const onCommandResult = useCallback(
    async (result: MobileLiveVoiceCommandResult) => {
      supportLog.add(
        result.ok ? "info" : "warn",
        "connection",
        `Live Voice probe [${LIVE_VOICE_DIAGNOSTIC_BUILD_ID}]: command result callback ${result.ok ? "success" : (result.error ?? "failed")}`,
      );
      mailbox.receive(result);
    },
    [mailbox],
  );

  const startSession = useCallback(async (input: LiveVoiceStartRequest): Promise<LiveVoiceStartActionResult> => {
    const currentOrigin = originRef.current;
    const actionContext = actionContextRef.current;
    const serverOnline = actionContext.servers.some(
      (server) => server.id === input.serverId && server.state === "online",
    );
    const originMatches = Boolean(
      currentOrigin &&
        currentOrigin.sessionId === input.clientSessionId &&
        currentOrigin.target.serverId === input.serverId &&
        currentOrigin.target.agentId === input.agentId &&
        currentOrigin.target.threadId === input.threadId &&
        currentOrigin.target.channelId === input.channelId,
    );
    const supported = Boolean(
      originMatches &&
        actionContext.foreground &&
        actionContext.activeServerId === input.serverId &&
        serverOnline &&
        hostRef.current.supportsLiveVoice(input.serverId, Boolean(input.channelId)),
    );
    const allowed = isCurrentLiveVoiceStartAction(currentOrigin, input, {
      mounted: mountedRef.current,
      foreground: actionContext.foreground,
      activeServerId: actionContext.activeServerId,
      serverOnline,
      sessionPhase: stateRef.current.phase,
      hostSessionActive: stateRef.current.hostSessionActive,
      supported,
    });
    if (!allowed) {
      supportLog.add(
        "warn",
        "connection",
        `Live Voice start rejected locally (mounted=${mountedRef.current}, foreground=${actionContext.foreground}, selected=${actionContext.activeServerId === input.serverId}, online=${serverOnline}, supported=${supported}, phase=${stateRef.current.phase}, active=${stateRef.current.hostSessionActive})`,
      );
      return { kind: "rejected" };
    }
    try {
      return { kind: "started", response: await hostRef.current.startLiveVoice(input) };
    } catch (error) {
      return { kind: isMobileLiveVoiceStartRejectedError(error) ? "rejected" : "uncertain" };
    }
  }, []);
  const stopSession = useCallback((input: LiveVoiceStopRequest) => hostRef.current.stopLiveVoice(input), []);
  const sendSessionText = useCallback(
    (input: LiveVoiceSendTextRequest) => hostRef.current.sendLiveVoiceText(input),
    [],
  );

  const subscribeLiveVoiceEvents = host.subscribeLiveVoiceEvents;
  useEffect(
    () =>
      subscribeLiveVoiceEvents((serverId, event) => {
        const current = originRef.current;
        if (!matchesLiveVoiceHostEvent(current, serverId, event)) return;
        if (event.status === "starting" || event.status === "started") return;
        void mailbox.send({ id: Crypto.randomUUID(), type: "host-event", event });
      }),
    [subscribeLiveVoiceEvents, mailbox],
  );

  const originServer = origin ? servers.find((server) => server.id === origin.target.serverId) : undefined;
  useEffect(() => {
    if (!origin) return;
    if (!foreground || activeServerId !== origin.target.serverId || originServer?.state !== "online") stop();
  }, [activeServerId, foreground, origin, originServer?.state, stop]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (errorTimer.current) clearTimeout(errorTimer.current);
      mailbox.dispose();
    },
    [mailbox],
  );

  const value = useMemo<MobileLiveVoiceContextValue>(
    () => ({
      state,
      origin,
      canStart,
      start,
      stop,
      toggleMute,
      resumeAudio,
      sendText,
      routesComposer: (target) => routesComposerToLiveVoice(origin, target, state),
    }),
    [canStart, origin, resumeAudio, sendText, start, state, stop, toggleMute],
  );

  const bridgeActive = foreground && Boolean(origin) && activeServerId === origin?.target.serverId;
  return (
    <MobileLiveVoiceContext.Provider value={value}>
      <View className="flex-1">
        {children}
        <LiveVoiceBridge
          active={bridgeActive}
          commands={commands}
          currentSessionId={origin?.sessionId ?? null}
          dom={{
            ...(Platform.OS === "android" ? androidReactNativeDomOptions : {}),
            webviewDebuggingEnabled: true,
            injectedJavaScript: `window.ReactNativeWebView?.postMessage(JSON.stringify({type:${JSON.stringify(LIVE_VOICE_DOM_DIAGNOSTIC_TYPE)},buildId:${JSON.stringify(LIVE_VOICE_DIAGNOSTIC_BUILD_ID)},stage:"webview-page-finished",hasProps:typeof window.$$EXPO_INITIAL_PROPS!=="undefined",hasBridge:typeof window.ReactNativeWebView!=="undefined"}));true;`,
            onLoadEnd: () =>
              supportLog.add(
                "info",
                "connection",
                `Live Voice probe [${LIVE_VOICE_DIAGNOSTIC_BUILD_ID}]: WebView load ended`,
              ),
            onError: () =>
              supportLog.add(
                "warn",
                "connection",
                `Live Voice probe [${LIVE_VOICE_DIAGNOSTIC_BUILD_ID}]: WebView load error`,
              ),
            onRenderProcessGone: () =>
              supportLog.add(
                "warn",
                "connection",
                `Live Voice probe [${LIVE_VOICE_DIAGNOSTIC_BUILD_ID}]: WebView renderer gone`,
              ),
            onMessage: (event) => {
              const diagnostic = parseLiveVoiceDomDiagnostic(event.nativeEvent.data);
              if (!diagnostic) return;
              const level = isLiveVoiceDomDiagnosticWarning(diagnostic) ? "warn" : "info";
              supportLog.add(level, "connection", formatLiveVoiceDomDiagnostic(diagnostic));
            },
            mediaPlaybackRequiresUserAction: false,
            containerStyle: {
              flex: 0,
              height: 1,
              left: 0,
              opacity: 0,
              position: "absolute",
              top: 0,
              width: 1,
            },
            pointerEvents: "none",
            scrollEnabled: false,
            style: { flex: 0, height: 1, width: 1 },
          }}
          onCommandResult={onCommandResult}
          onDiagnostic={onBridgeDiagnostic}
          onState={onBridgeState}
          sendText={sendSessionText}
          startSession={startSession}
          stopSession={stopSession}
        />
      </View>
    </MobileLiveVoiceContext.Provider>
  );
}

export function useMobileLiveVoice(): MobileLiveVoiceContextValue {
  const value = useContext(MobileLiveVoiceContext);
  if (!value) throw new Error("useMobileLiveVoice must be used within MobileLiveVoiceProvider.");
  return value;
}
