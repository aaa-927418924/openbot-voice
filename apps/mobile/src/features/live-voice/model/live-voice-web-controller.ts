import type { LiveVoiceWireEvent } from "@openbot/contracts/team-protocol/live-voice-v1";
import type { MobileLiveVoiceOrigin, MobileLiveVoiceState } from "./live-voice";

const START_TIMEOUT_MS = 30_000;
const LEVEL_SAMPLE_MS = 100;

export interface LiveVoiceStartRequest {
  serverId: string;
  agentId: string;
  threadId: string;
  channelId?: string;
  clientSessionId: string;
  sdpOffer: string;
}

export interface LiveVoiceStopRequest {
  serverId: string;
  agentId: string;
  threadId: string;
  sessionId: string;
}

export interface LiveVoiceSendTextRequest extends LiveVoiceStopRequest {
  text: string;
}

export interface LiveVoiceStartResponse {
  sessionId: string;
  sdpAnswer: string;
}

export type LiveVoiceDiagnosticStep =
  | "dom-bridge"
  | "command"
  | "startup"
  | "microphone"
  | "audio-context"
  | "peer"
  | "offer"
  | "local-description"
  | "ice"
  | "host-request"
  | "remote-description";

export type LiveVoiceDiagnosticOutcome =
  | "mounted"
  | "received"
  | "started"
  | "ready"
  | "waiting"
  | "complete"
  | "accepted"
  | "rejected"
  | "connected"
  | "disconnected"
  | "failed"
  | "timeout"
  | "permission-denied"
  | "unsupported"
  | "blocked";

export interface LiveVoiceDiagnostic {
  step: LiveVoiceDiagnosticStep;
  outcome: LiveVoiceDiagnosticOutcome;
  elapsedMs: number;
  errorName?: string;
  errorMessage?: string;
}

/** Plain data crosses the Expo DOM boundary; Error prototypes do not. */
export type LiveVoiceStartActionResult =
  | { kind: "started"; response: LiveVoiceStartResponse }
  | { kind: "rejected" }
  | { kind: "uncertain" };

export interface LiveVoiceWebActions {
  startSession(input: LiveVoiceStartRequest): Promise<LiveVoiceStartActionResult>;
  stopSession(input: LiveVoiceStopRequest): Promise<void>;
  sendText(input: LiveVoiceSendTextRequest): Promise<void>;
  onState(state: MobileLiveVoiceState): Promise<void>;
  onDiagnostic?(diagnostic: LiveVoiceDiagnostic): Promise<void>;
}

interface ActiveVoiceSession {
  origin: MobileLiveVoiceOrigin;
  peer?: RTCPeerConnection;
  stream?: MediaStream;
  audio?: HTMLAudioElement;
  audioContext?: AudioContext;
  microphoneAnalyser?: AnalyserNode;
  playbackAnalyser?: AnalyserNode;
  playbackSource?: MediaStreamAudioSourceNode;
  sampleTimer?: number;
  startTimer?: number;
  connectedTimer?: number;
  startedAt?: number;
  cancelled: boolean;
  startRequested: boolean;
  startResultKnown: boolean;
  hostAccepted: boolean;
  leaseUncertain: boolean;
  stopSucceeded: boolean;
  stopSucceededForHostSessionId?: string;
  stopPromise?: Promise<boolean>;
  hostSessionId?: string;
  failureAfterStop?: string;
  muted: boolean;
  audioBlocked: boolean;
  microphoneBlocked: boolean;
  error?: string;
  startedAtMs: number;
  currentStep: LiveVoiceDiagnosticStep;
}

const EMPTY_LEVELS = () => Array<number>(16).fill(0);

export function createLiveVoiceWebController(actions: LiveVoiceWebActions) {
  let active: ActiveVoiceSession | undefined;
  let disposed = false;
  let publishQueue = Promise.resolve();
  let pendingSample: MobileLiveVoiceState | undefined;
  let samplePumpQueued = false;

  const queueState = (state: MobileLiveVoiceState, sample: boolean) => {
    if (sample) {
      pendingSample = state;
      if (samplePumpQueued) return;
      samplePumpQueued = true;
      publishQueue = publishQueue
        .then(async () => {
          const latest = pendingSample;
          pendingSample = undefined;
          samplePumpQueued = false;
          if (latest) await actions.onState(latest);
        })
        .catch(() => {
          pendingSample = undefined;
          samplePumpQueued = false;
        });
      return;
    }
    pendingSample = undefined;
    publishQueue = publishQueue.then(() => actions.onState(state)).catch(() => undefined);
  };

  const hostMayBeActive = (session: ActiveVoiceSession) =>
    session.hostAccepted || session.leaseUncertain || (session.startRequested && !session.startResultKnown);

  const report = (
    session: ActiveVoiceSession,
    step: LiveVoiceDiagnosticStep,
    outcome: LiveVoiceDiagnosticOutcome,
    details?: Pick<LiveVoiceDiagnostic, "errorName" | "errorMessage">,
  ) => {
    session.currentStep = step;
    const record = actions.onDiagnostic;
    if (!record) return;
    void record({ step, outcome, elapsedMs: Math.max(0, Date.now() - session.startedAtMs), ...details }).catch(
      () => undefined,
    );
  };

  const publish = (
    session: ActiveVoiceSession,
    phase: MobileLiveVoiceState["phase"],
    hostSessionActive: boolean,
    sample = false,
  ) => {
    if (disposed) return;
    const state: MobileLiveVoiceState = {
      phase,
      sessionId: session.origin.sessionId,
      hostSessionActive,
      muted: session.muted,
      audioBlocked: session.audioBlocked,
      microphoneBlocked: session.microphoneBlocked,
      microphoneLevels: readLevels(session.microphoneAnalyser, session.muted),
      playbackLevels: readLevels(session.playbackAnalyser, false),
      elapsedMs: session.startedAt ? Math.max(0, Date.now() - session.startedAt) : 0,
      ...(session.error ? { error: session.error } : {}),
    };
    queueState(state, sample);
  };

  const closeMedia = (session: ActiveVoiceSession) => {
    if (session.sampleTimer !== undefined) window.clearInterval(session.sampleTimer);
    if (session.startTimer !== undefined) window.clearTimeout(session.startTimer);
    if (session.connectedTimer !== undefined) window.clearTimeout(session.connectedTimer);
    session.sampleTimer = undefined;
    session.startTimer = undefined;
    session.connectedTimer = undefined;
    if (session.peer) {
      session.peer.ontrack = null;
      session.peer.onconnectionstatechange = null;
      session.peer.close();
      session.peer = undefined;
    }
    if (session.audio) {
      session.audio.pause();
      session.audio.srcObject = null;
      session.audio.remove();
      session.audio = undefined;
    }
    session.playbackSource?.disconnect();
    session.playbackSource = undefined;
    void session.audioContext?.close().catch(() => undefined);
    session.audioContext = undefined;
    session.microphoneAnalyser = undefined;
    session.playbackAnalyser = undefined;
    for (const track of session.stream?.getTracks() ?? []) track.stop();
    session.stream = undefined;
  };

  const finish = (session: ActiveVoiceSession, phase: MobileLiveVoiceState["phase"], error?: string) => {
    if (active === session) active = undefined;
    session.error = error;
    closeMedia(session);
    publish(session, phase, false);
  };

  const requestStop = (session: ActiveVoiceSession, errorAfterStop?: string): Promise<boolean> => {
    session.cancelled = true;
    session.failureAfterStop ??= errorAfterStop;
    closeMedia(session);
    if (!session.startRequested) {
      finish(session, session.failureAfterStop ? "error" : "idle", session.failureAfterStop);
      return Promise.resolve(true);
    }
    if (session.stopPromise) {
      publish(session, "stopping", hostMayBeActive(session));
      return session.stopPromise;
    }
    publish(session, "stopping", hostMayBeActive(session));
    const hostSessionIdAtRequest = session.hostAccepted ? session.hostSessionId : undefined;
    const stopSessionId = session.hostSessionId ?? session.origin.sessionId;
    const stopPromise = actions
      .stopSession({
        serverId: session.origin.target.serverId,
        agentId: session.origin.target.agentId,
        threadId: session.origin.target.threadId,
        sessionId: stopSessionId,
      })
      .then(
        () => {
          session.stopSucceeded = true;
          if (hostSessionIdAtRequest === stopSessionId) {
            session.stopSucceededForHostSessionId = stopSessionId;
          }
          session.hostAccepted = false;
          session.leaseUncertain = false;
          finish(session, session.failureAfterStop ? "error" : "idle", session.failureAfterStop);
          return true;
        },
        () => {
          if (active !== session || disposed) return false;
          session.error = "stop";
          session.leaseUncertain = true;
          publish(session, "error", true);
          return false;
        },
      )
      .finally(() => {
        if (session.stopPromise === stopPromise) session.stopPromise = undefined;
      });
    session.stopPromise = stopPromise;
    return stopPromise;
  };

  const stopLateAcceptedSession = async (session: ActiveVoiceSession, sessionId: string): Promise<void> => {
    session.hostSessionId = sessionId;
    session.startResultKnown = true;
    session.hostAccepted = true;
    // A stop sent before this response may only have found no lease. Only a
    // successful stop sent after acceptance confirms this returned session ID.
    if (session.stopPromise) await session.stopPromise;
    if (session.stopSucceededForHostSessionId === sessionId) {
      session.hostAccepted = false;
      session.leaseUncertain = false;
      if (active === session) finish(session, session.failureAfterStop ? "error" : "idle", session.failureAfterStop);
      return;
    }
    if (active === session && !disposed) publish(session, "stopping", true);
    try {
      await actions.stopSession({
        serverId: session.origin.target.serverId,
        agentId: session.origin.target.agentId,
        threadId: session.origin.target.threadId,
        sessionId,
      });
      session.stopSucceeded = true;
      session.stopSucceededForHostSessionId = sessionId;
      session.hostAccepted = false;
      session.leaseUncertain = false;
      if (active === session) finish(session, session.failureAfterStop ? "error" : "idle", session.failureAfterStop);
    } catch {
      if (active !== session || disposed) return;
      session.leaseUncertain = true;
      session.error = "stop";
      publish(session, "error", true);
    }
  };

  const start = async (origin: MobileLiveVoiceOrigin) => {
    if (disposed || active) throw new Error("Live voice is already active.");
    const session: ActiveVoiceSession = {
      origin,
      cancelled: false,
      startRequested: false,
      startResultKnown: false,
      hostAccepted: false,
      leaseUncertain: false,
      stopSucceeded: false,
      muted: false,
      audioBlocked: false,
      microphoneBlocked: false,
      startedAtMs: Date.now(),
      currentStep: "startup",
    };
    active = session;
    report(session, "startup", "started");
    publish(session, "connecting", false);
    const isCurrent = () => !disposed && active === session && !session.cancelled;
    // Cover microphone permission, SDP creation, ICE gathering and the host request. Previously
    // this deadline started only after all local media setup had completed.
    session.startTimer = window.setTimeout(() => {
      if (isCurrent()) {
        report(session, session.currentStep, "timeout");
        void requestStop(session, "unavailable");
      }
    }, START_TIMEOUT_MS);
    try {
      report(session, "microphone", "waiting");
      if (!navigator.mediaDevices?.getUserMedia)
        throw new DOMException("Microphone is unavailable.", "NotSupportedError");
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent()) {
        for (const track of session.stream.getTracks()) track.stop();
        return;
      }
      report(session, "microphone", "ready");
      const peer = new RTCPeerConnection();
      session.peer = peer;
      report(session, "peer", "ready");
      for (const track of session.stream.getAudioTracks()) track.enabled = !session.muted;

      const AudioContextConstructor = window.AudioContext;
      if (AudioContextConstructor) {
        session.audioContext = new AudioContextConstructor();
        try {
          await session.audioContext.resume();
        } catch {
          session.audioBlocked = true;
          report(session, "audio-context", "blocked");
        }
        if (!isCurrent()) return;
        if (!session.audioBlocked) report(session, "audio-context", "ready");
        session.microphoneAnalyser = session.audioContext.createAnalyser();
        session.microphoneAnalyser.fftSize = 128;
        session.audioContext.createMediaStreamSource(session.stream).connect(session.microphoneAnalyser);
        session.sampleTimer = window.setInterval(
          () => publish(session, session.startedAt ? "live" : "connecting", hostMayBeActive(session), true),
          LEVEL_SAMPLE_MS,
        );
      }

      for (const track of session.stream.getAudioTracks()) peer.addTrack(track, session.stream);
      peer.ontrack = (event) => {
        if (!isCurrent()) return;
        session.audio?.pause();
        if (session.audio) {
          session.audio.srcObject = null;
          session.audio.remove();
        }
        session.playbackSource?.disconnect();
        const playbackStream = event.streams[0] ?? new MediaStream([event.track]);
        session.audio = new Audio();
        session.audio.autoplay = true;
        session.audio.srcObject = playbackStream;
        if (session.audioContext) {
          session.playbackAnalyser = session.audioContext.createAnalyser();
          session.playbackAnalyser.fftSize = 128;
          session.playbackSource = session.audioContext.createMediaStreamSource(playbackStream);
          session.playbackSource.connect(session.playbackAnalyser);
        }
        void session.audio.play().then(
          () => {
            if (!isCurrent()) return;
            session.audioBlocked = false;
            if (peer.connectionState === "connected") publish(session, "live", true);
          },
          () => {
            if (!isCurrent()) return;
            session.audioBlocked = true;
            publish(session, peer.connectionState === "connected" ? "live" : "connecting", true);
          },
        );
      };
      peer.onconnectionstatechange = () => {
        if (!isCurrent()) return;
        if (peer.connectionState === "connected") {
          report(session, "peer", "connected");
          if (session.startTimer !== undefined) window.clearTimeout(session.startTimer);
          if (session.connectedTimer !== undefined) window.clearTimeout(session.connectedTimer);
          session.startTimer = undefined;
          session.connectedTimer = undefined;
          session.startedAt ??= Date.now();
          publish(session, "live", true);
        } else if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          report(session, "peer", peer.connectionState === "disconnected" ? "disconnected" : "failed");
          void requestStop(session, "unavailable");
        }
      };

      report(session, "offer", "waiting");
      const offer = await peer.createOffer();
      report(session, "offer", "ready");
      report(session, "local-description", "waiting");
      await peer.setLocalDescription(offer);
      report(session, "local-description", "ready");
      report(session, "ice", "waiting");
      await waitForIce(peer);
      report(session, "ice", "complete");
      if (!isCurrent()) return;
      const sdpOffer = peer.localDescription?.sdp;
      if (!sdpOffer) throw new Error("Live voice did not create an SDP offer.");

      session.startRequested = true;
      publish(session, "connecting", hostMayBeActive(session));
      report(session, "host-request", "started");
      const outcome = await actions.startSession({
        serverId: origin.target.serverId,
        agentId: origin.target.agentId,
        threadId: origin.target.threadId,
        ...(origin.target.channelId ? { channelId: origin.target.channelId } : {}),
        clientSessionId: origin.sessionId,
        sdpOffer,
      });
      session.startResultKnown = true;
      if (outcome.kind === "rejected") {
        report(session, "host-request", "rejected");
        session.hostAccepted = false;
        session.leaseUncertain = false;
        session.stopSucceeded = true;
        if (active === session) {
          finish(
            session,
            session.cancelled && !session.failureAfterStop ? "idle" : "error",
            session.failureAfterStop ?? "unavailable",
          );
        }
        return;
      }
      if (outcome.kind !== "started") {
        session.leaseUncertain = true;
        report(session, "host-request", "failed");
        throw new Error("Live Voice start outcome is uncertain.");
      }
      report(session, "host-request", "accepted");
      const result = outcome.response;
      session.hostAccepted = true;
      session.hostSessionId = result.sessionId;
      if (!isCurrent()) {
        await stopLateAcceptedSession(session, result.sessionId);
        return;
      }
      if (result.sessionId !== origin.sessionId) throw new Error("Live voice session identity changed.");
      report(session, "remote-description", "waiting");
      await peer.setRemoteDescription({ type: "answer", sdp: result.sdpAnswer });
      report(session, "remote-description", "ready");
      if (!isCurrent()) {
        await stopLateAcceptedSession(session, result.sessionId);
        return;
      }
      if (session.startTimer !== undefined) window.clearTimeout(session.startTimer);
      session.startTimer = undefined;
      session.connectedTimer = window.setTimeout(() => {
        if (isCurrent() && peer.connectionState !== "connected") void requestStop(session, "unavailable");
      }, START_TIMEOUT_MS);
    } catch (error) {
      if (active !== session || disposed) return;
      const details = describeVoiceError(error);
      const microphoneBlocked = ["NotAllowedError", "SecurityError"].includes(details.errorName);
      session.microphoneBlocked = microphoneBlocked;
      const failure = microphoneBlocked ? "microphone" : "unavailable";
      report(
        session,
        session.currentStep,
        diagnosticFailureOutcome(details.errorName),
        session.currentStep === "microphone" ? details : undefined,
      );
      if (session.startRequested) {
        if (!session.startResultKnown) {
          session.startResultKnown = true;
          session.leaseUncertain = true;
        }
        session.error = failure;
        void requestStop(session, failure);
      } else {
        finish(session, "error", failure);
      }
    }
  };

  const stop = () => {
    if (active) void requestStop(active);
  };

  const toggleMute = () => {
    const session = active;
    if (!session || session.cancelled) return;
    session.muted = !session.muted;
    for (const track of session.stream?.getAudioTracks() ?? []) track.enabled = !session.muted;
    publish(session, session.startedAt ? "live" : "connecting", hostMayBeActive(session));
  };

  const resumeAudio = async () => {
    const session = active;
    if (!session?.audio || session.cancelled) return;
    try {
      await session.audio.play();
      session.audioBlocked = false;
      publish(session, session.startedAt ? "live" : "connecting", hostMayBeActive(session));
    } catch {
      session.audioBlocked = true;
      publish(session, session.startedAt ? "live" : "connecting", hostMayBeActive(session));
    }
  };

  const sendText = async (text: string) => {
    const session = active;
    if (!session?.startedAt || session.cancelled) throw new Error("Live voice is not ready.");
    await actions.sendText({
      serverId: session.origin.target.serverId,
      agentId: session.origin.target.agentId,
      threadId: session.origin.target.threadId,
      sessionId: session.origin.sessionId,
      text,
    });
  };

  const handleHostEvent = (event: LiveVoiceWireEvent) => {
    const session = active;
    if (!session || session.origin.sessionId !== event.sessionId) return;
    if (event.status === "starting" || event.status === "started") return;
    if (event.status === "closed") {
      session.cancelled = true;
      session.stopSucceeded = true;
      session.hostAccepted = false;
      session.leaseUncertain = false;
      finish(session, "idle");
      return;
    }
    session.error = "unavailable";
    void requestStop(session, "unavailable");
  };

  const dispose = () => {
    disposed = true;
    const session = active;
    if (!session) return;
    session.cancelled = true;
    closeMedia(session);
    if (session.startRequested) void requestStop(session);
    else active = undefined;
  };

  return { start, stop, toggleMute, resumeAudio, sendText, handleHostEvent, dispose };
}

async function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    let timer: number;
    const cleanup = () => {
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
    };
    const onChange = () => {
      if (peer.iceGatheringState !== "complete") return;
      cleanup();
      resolve();
    };
    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Live voice ICE gathering timed out."));
    }, START_TIMEOUT_MS);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

function describeVoiceError(error: unknown): { errorName: string; errorMessage: string } {
  let errorName = "UnknownError";
  let errorMessage = "";
  if (typeof error === "object" && error !== null) {
    if ("name" in error && typeof error.name === "string") errorName = error.name;
    if ("message" in error && typeof error.message === "string") errorMessage = error.message;
  } else if (typeof error === "string") {
    errorMessage = error;
  } else if (error !== undefined) {
    errorMessage = String(error);
  }
  return {
    errorName: errorName.slice(0, 80),
    errorMessage: (errorMessage || errorName).slice(0, 240),
  };
}

function diagnosticFailureOutcome(errorName: string): "failed" | "timeout" | "permission-denied" | "unsupported" {
  if (["NotAllowedError", "SecurityError"].includes(errorName)) return "permission-denied";
  if (["NotSupportedError", "NotFoundError"].includes(errorName)) return "unsupported";
  if (errorName === "TimeoutError") return "timeout";
  return "failed";
}

function readLevels(analyser: AnalyserNode | undefined, muted: boolean): number[] {
  if (!analyser || muted) return EMPTY_LEVELS();
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
