import type { LiveVoiceEvent, OpenBotDesktopApi } from "@openbot/contracts/ipc";

export type LiveVoicePhase = "idle" | "connecting" | "live" | "stopping" | "error";

export interface LiveVoiceState {
  phase: LiveVoicePhase;
  audioBlocked: boolean;
  microphoneBlocked: boolean;
  hostSessionActive: boolean;
  stopPending: boolean;
  muted: boolean;
  microphoneLevels: number[];
  playbackLevels: number[];
  error?: string;
}

export interface LiveVoiceTarget {
  agentId: string;
  threadId: string;
  /**
   * The machine running the agent: `\"local\"`, or a remote host. It is fixed when the session starts
   * and named on every call, because stop and send-text have to reach the machine holding the
   * microphone even after the window has moved to another server.
   */
  serverId: string;
  channelId?: string;
}

type LiveVoiceApi = Pick<OpenBotDesktopApi["liveVoice"], "start" | "stop" | "onEvent" | "sendText">;

interface LiveVoiceSession {
  id: string;
  target: LiveVoiceTarget;
  peer: RTCPeerConnection | undefined;
  stream: MediaStream | undefined;
  unsubscribe: (() => void) | undefined;
  startRequested: boolean;
  cancelled: boolean;
  stopPending: boolean;
  error: string | undefined;
  timer: number | undefined;
  muted: boolean;
  audioContext: AudioContext | undefined;
  microphoneAnalyser: AnalyserNode | undefined;
  playbackAnalyser: AnalyserNode | undefined;
  animationFrame: number | undefined;
  cancelIceWait: (() => void) | undefined;
  startResolved: boolean;
  closedBeforeStartResolved: boolean;
  startFailure: string | undefined;
  generation: number;
}

const START_TIMEOUT_MS = 30_000;
const LAUNCH_ERROR_CLEAR_MS = 5_000;
const IDLE_STATE: LiveVoiceState = {
  phase: "idle",
  audioBlocked: false,
  microphoneBlocked: false,
  hostSessionActive: false,
  stopPending: false,
  muted: false,
  microphoneLevels: Array(16).fill(0),
  playbackLevels: Array(16).fill(0),
};

/** Owns browser media and the provider session for the app-wide live call. */
export function createLiveVoiceController(api: LiveVoiceApi | undefined, onState: (state: LiveVoiceState) => void) {
  let active: LiveVoiceSession | undefined;
  let generation = 0;
  let audio: HTMLAudioElement | undefined;
  let launchErrorTimer: number | undefined;
  let disposed = false;
  let latestState = IDLE_STATE;

  const setState = (state: LiveVoiceState) => {
    latestState = state;
    if (!disposed && state.phase === "error") {
      if (launchErrorTimer === undefined) {
        launchErrorTimer = window.setTimeout(() => {
          launchErrorTimer = undefined;
          if (latestState.phase === "error") {
            setState(
              latestState.hostSessionActive
                ? { ...latestState, phase: "connecting", error: undefined, microphoneBlocked: false }
                : IDLE_STATE,
            );
          }
        }, LAUNCH_ERROR_CLEAR_MS);
      }
    } else if (launchErrorTimer !== undefined) {
      window.clearTimeout(launchErrorTimer);
      launchErrorTimer = undefined;
    }
    if (!disposed) onState(state);
  };

  function publish(
    session: LiveVoiceSession,
    phase: LiveVoicePhase,
    options: Pick<LiveVoiceState, "audioBlocked" | "microphoneBlocked"> = {
      audioBlocked: false,
      microphoneBlocked: false,
    },
  ): void {
    setState({
      phase,
      ...options,
      hostSessionActive: session.startRequested,
      stopPending: session.stopPending,
      muted: session.muted,
      microphoneLevels: stateLevels(session.microphoneAnalyser, session.muted),
      playbackLevels: stateLevels(session.playbackAnalyser, false),
      error: session.error,
    });
  }

  function closeMedia(session: LiveVoiceSession): void {
    if (session.timer !== undefined) window.clearTimeout(session.timer);
    session.timer = undefined;
    session.cancelIceWait?.();
    session.cancelIceWait = undefined;
    if (session.peer) {
      session.peer.ontrack = null;
      session.peer.onconnectionstatechange = null;
      session.peer.close();
      session.peer = undefined;
    }
    if (session.animationFrame !== undefined) cancelAnimationFrame(session.animationFrame);
    session.animationFrame = undefined;
    void session.audioContext?.close().catch(() => undefined);
    session.audioContext = undefined;
    session.microphoneAnalyser = undefined;
    session.playbackAnalyser = undefined;
    for (const track of session.stream?.getTracks() ?? []) track.stop();
    session.stream = undefined;
    if (audio) audio.srcObject = null;
    audio = undefined;
  }

  function stateLevels(analyser: AnalyserNode | undefined, muted: boolean): number[] {
    if (!analyser || muted) return Array(16).fill(0);
    const values = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(values);
    return Array.from({ length: 16 }, (_, index) => {
      const start = Math.floor((index * values.length) / 16);
      const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / 16));
      let sum = 0;
      for (let sample = start; sample < end; sample += 1) sum += values[sample] ?? 0;
      return Math.round((sum / (end - start) / 255) * 100);
    });
  }

  function sampleLevels(session: LiveVoiceSession): void {
    if (active !== session || session.cancelled) return;
    setState({
      ...latestState,
      microphoneLevels: stateLevels(session.microphoneAnalyser, session.muted),
      playbackLevels: stateLevels(session.playbackAnalyser, false),
    });
    session.animationFrame = requestAnimationFrame(() => sampleLevels(session));
  }

  function finish(session: LiveVoiceSession, phase: LiveVoicePhase, error?: string): void {
    if (active === session) active = undefined;
    session.unsubscribe?.();
    session.unsubscribe = undefined;
    closeMedia(session);
    setState({ ...IDLE_STATE, phase, error });
  }

  function requestStop(session: LiveVoiceSession, error = session.error, microphoneBlocked = false): void {
    session.cancelled = true;
    session.error = error;
    closeMedia(session);
    if (!session.startRequested || !api) {
      finish(session, error ? "error" : "idle", error);
      if (error && microphoneBlocked) setState({ ...IDLE_STATE, phase: "error", error, microphoneBlocked: true });
      return;
    }

    publish(session, error ? "error" : "stopping", { audioBlocked: false, microphoneBlocked });
    if (session.stopPending) return;
    session.stopPending = true;
    publish(session, error ? "error" : "stopping", { audioBlocked: false, microphoneBlocked });
    void api
      .stop(
        { agentId: session.target.agentId, threadId: session.target.threadId, sessionId: session.id },
        session.target.serverId,
      )
      .then(
        () => {
          if (active === session) {
            session.stopPending = false;
            session.error = session.startFailure;
            publish(session, session.startFailure ? "error" : "stopping", {
              audioBlocked: false,
              microphoneBlocked,
            });
          }
        },
        (stopError: unknown) => {
          if (active !== session) return;
          session.stopPending = false;
          session.error = stopError instanceof Error ? stopError.message : session.error;
          publish(session, "error", { audioBlocked: false, microphoneBlocked });
        },
      );
  }

  async function resumeAudio(): Promise<void> {
    if (!audio?.srcObject || !active || active.cancelled) return;
    try {
      await audio.play();
      if (active?.peer?.connectionState === "connected") {
        publish(active, "live", { audioBlocked: false, microphoneBlocked: false });
      }
    } catch {
      if (active) publish(active, "live", { audioBlocked: true, microphoneBlocked: false });
    }
  }

  async function waitForIce(peer: RTCPeerConnection, session: LiveVoiceSession): Promise<void> {
    if (peer.iceGatheringState === "complete") return;
    await new Promise<void>((resolve, reject) => {
      let timer: number;
      const cleanup = () => {
        window.clearTimeout(timer);
        peer.removeEventListener("icegatheringstatechange", onStateChange);
        session.cancelIceWait = undefined;
      };
      timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("Live voice ICE gathering timed out."));
      }, START_TIMEOUT_MS);
      const cancel = () => {
        cleanup();
        reject(new DOMException("ICE gathering was cancelled.", "AbortError"));
      };
      const onStateChange = () => {
        if (peer.iceGatheringState !== "complete") return;
        cleanup();
        resolve();
      };
      session.cancelIceWait = cancel;
      peer.addEventListener("icegatheringstatechange", onStateChange);
    });
  }

  async function start(target: LiveVoiceTarget): Promise<void> {
    if (!api || active || disposed) return;
    if (launchErrorTimer !== undefined) {
      window.clearTimeout(launchErrorTimer);
      launchErrorTimer = undefined;
    }
    const session: LiveVoiceSession = {
      generation: ++generation,
      id: crypto.randomUUID(),
      target,
      peer: undefined,
      stream: undefined,
      unsubscribe: undefined,
      startRequested: false,
      cancelled: false,
      stopPending: false,
      error: undefined,
      timer: undefined,
      muted: false,
      audioContext: undefined,
      microphoneAnalyser: undefined,
      playbackAnalyser: undefined,
      animationFrame: undefined,
      cancelIceWait: undefined,
      startResolved: false,
      closedBeforeStartResolved: false,
      startFailure: undefined,
    };
    active = session;
    audio ??= new Audio();
    audio.autoplay = true;
    setState({ ...IDLE_STATE, phase: "connecting" });
    const isOwned = () => !disposed && active === session;
    const canContinue = () => isOwned() && !session.cancelled;

    try {
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!canContinue()) {
        for (const track of session.stream.getTracks()) track.stop();
        return;
      }
      for (const track of session.stream.getAudioTracks()) track.enabled = !session.muted;

      const peer = new RTCPeerConnection();
      session.peer = peer;
      const AudioContextConstructor = window.AudioContext;
      if (AudioContextConstructor) {
        session.audioContext = new AudioContextConstructor();
        await session.audioContext.resume();
        session.microphoneAnalyser = session.audioContext.createAnalyser();
        session.microphoneAnalyser.fftSize = 128;
        session.audioContext.createMediaStreamSource(session.stream).connect(session.microphoneAnalyser);
        session.animationFrame = requestAnimationFrame(() => sampleLevels(session));
      }
      for (const track of session.stream.getAudioTracks()) peer.addTrack(track, session.stream);
      peer.ontrack = (event) => {
        if (!canContinue() || !audio) return;
        const playbackStream = event.streams[0] ?? new MediaStream([event.track]);
        audio.srcObject = playbackStream;
        if (session.audioContext) {
          session.playbackAnalyser = session.audioContext.createAnalyser();
          session.playbackAnalyser.fftSize = 128;
          session.audioContext.createMediaStreamSource(playbackStream).connect(session.playbackAnalyser);
        }
        void audio.play().then(
          () => {
            if (canContinue() && peer.connectionState === "connected")
              publish(session, "live", { audioBlocked: false, microphoneBlocked: false });
          },
          () => {
            if (canContinue())
              publish(session, peer.connectionState === "connected" ? "live" : "connecting", {
                audioBlocked: true,
                microphoneBlocked: false,
              });
          },
        );
      };
      peer.onconnectionstatechange = () => {
        if (!canContinue()) return;
        if (peer.connectionState === "connected") {
          publish(session, "live", {
            audioBlocked: latestState.audioBlocked,
            microphoneBlocked: latestState.microphoneBlocked,
          });
          return;
        }
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          requestStop(session, "");
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIce(peer, session);
      if (!canContinue()) return;
      const sdpOffer = peer.localDescription?.sdp;
      if (!sdpOffer) throw new Error("Live voice did not create an SDP offer.");

      // Subscribe before the request. The host can report a session failure before start resolves.
      session.unsubscribe = api.onEvent((event: LiveVoiceEvent) => {
        if (
          !isOwned() ||
          event.sessionId !== session.id ||
          event.agentId !== target.agentId ||
          event.threadId !== target.threadId
        )
          return;
        if (event.status === "closed") {
          session.closedBeforeStartResolved = !session.cancelled && !session.startResolved;
          finish(session, session.startFailure ? "error" : "idle", session.startFailure);
          return;
        }
        if (event.status === "error") requestStop(session, event.message ?? "");
      });
      session.startRequested = true;
      publish(session, "connecting");
      session.timer = window.setTimeout(() => {
        if (canContinue()) requestStop(session, "");
      }, START_TIMEOUT_MS);
      const result = await api.start(
        {
          agentId: target.agentId,
          threadId: target.threadId,
          clientSessionId: session.id,
          sdpOffer,
          ...(target.channelId ? { channelId: target.channelId } : {}),
        },
        target.serverId,
      );
      session.startResolved = true;
      if (result.kind === "refused") {
        if (canContinue()) finish(session, "error", result.message);
        else if (session.closedBeforeStartResolved && generation === session.generation && !active) {
          setState({ ...IDLE_STATE, phase: "error", error: result.message });
        }
        return;
      }
      if (!canContinue()) return;
      if (result.sessionId !== session.id) throw new Error("Live voice session identity changed.");
      await peer.setRemoteDescription({ type: "answer", sdp: result.sdpAnswer });
      if (!canContinue()) return;
      if (session.timer !== undefined) window.clearTimeout(session.timer);
      session.timer = undefined;
      session.timer = window.setTimeout(() => {
        if (canContinue() && peer.connectionState !== "connected") requestStop(session, "");
      }, START_TIMEOUT_MS);
    } catch (error) {
      if (!isOwned()) {
        if (session.closedBeforeStartResolved && generation === session.generation && !active) {
          setState({
            ...IDLE_STATE,
            phase: "error",
            error: error instanceof Error ? error.message : undefined,
          });
        }
        return;
      }
      const blocked = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
      const message = blocked ? undefined : error instanceof Error ? error.message : undefined;
      if (session.startRequested) {
        if (!session.startResolved && !session.cancelled) session.startFailure = message;
        requestStop(session, message ?? "", blocked);
      } else {
        finish(session, "error", message);
        if (blocked) setState({ ...IDLE_STATE, phase: "error", microphoneBlocked: true });
      }
    }
  }

  async function stop(): Promise<void> {
    const session = active;
    if (!session) return;
    if (!session.startRequested) {
      session.cancelled = true;
      finish(session, "idle");
      return;
    }
    requestStop(session);
  }

  function toggleMute(): void {
    const session = active;
    if (!session || session.cancelled) return;
    session.muted = !session.muted;
    for (const track of session.stream?.getAudioTracks() ?? []) track.enabled = !session.muted;
    publish(session, latestState.phase, {
      audioBlocked: latestState.audioBlocked,
      microphoneBlocked: latestState.microphoneBlocked,
    });
  }

  async function sendText(text: string): Promise<void> {
    const session = active;
    if (!api || !session?.startRequested || session.cancelled) {
      throw new Error("Live voice is not ready yet.");
    }
    if (text.length === 0) return;
    await api.sendText(
      { agentId: session.target.agentId, threadId: session.target.threadId, sessionId: session.id, text },
      session.target.serverId,
    );
  }

  function dispose(): void {
    disposed = true;
    window.removeEventListener("beforeunload", stopOnUnload);
    if (launchErrorTimer !== undefined) window.clearTimeout(launchErrorTimer);
    launchErrorTimer = undefined;
    const session = active;
    if (session) {
      session.cancelled = true;
      closeMedia(session);
      session.unsubscribe?.();
      session.unsubscribe = undefined;
      active = undefined;
      if (api && session.startRequested)
        void api
          .stop(
            { agentId: session.target.agentId, threadId: session.target.threadId, sessionId: session.id },
            session.target.serverId,
          )
          .catch(() => undefined);
    }
    audio = undefined;
  }

  const stopOnUnload = () => void stop();
  window.addEventListener("beforeunload", stopOnUnload);

  return { start, stop, dispose, resumeAudio, toggleMute, sendText };
}
