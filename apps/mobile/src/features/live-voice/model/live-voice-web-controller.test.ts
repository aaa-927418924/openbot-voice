import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileLiveVoiceState } from "./live-voice";
import { createLiveVoiceWebController, type LiveVoiceWebActions } from "./live-voice-web-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const origin = {
  sessionId: "voice-session-1",
  target: {
    serverId: "server-1",
    agentId: "agent-1",
    threadId: "thread-1",
    agentName: "Bot",
    avatarSeed: "seed",
    avatarHue: null,
  },
};

class FakeTrack {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return [this.track];
  }
}

class FakeAnalyser {
  fftSize = 0;
  get frequencyBinCount() {
    return 64;
  }
  getByteFrequencyData(values: Uint8Array) {
    values.fill(0);
  }
}

class FakeAudioContext {
  state = "running";
  async resume() {}
  async close() {}
  createAnalyser() {
    return new FakeAnalyser();
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
}

class FakeAudio {
  autoplay = false;
  playsInline = false;
  srcObject: MediaStream | null = null;
  async play() {}
  pause() {}
  remove() {}
}

class FakePeer {
  static instances: FakePeer[] = [];
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() {
    FakePeer.instances.push(this);
  }
  addTrack() {}
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }
  async setRemoteDescription() {}
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.connectionState = "closed";
  }
  connect() {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }
}

function installWebRtcStubs() {
  FakePeer.instances = [];
  const stream = new FakeStream();
  let nextTimer = 0;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("MediaStream", class extends FakeStream {});
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("window", {
    AudioContext: FakeAudioContext,
    setInterval: () => ++nextTimer,
    clearInterval: vi.fn(),
    setTimeout: () => ++nextTimer,
    clearTimeout: vi.fn(),
  });
  return { stream };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Live Voice WebRTC controller lifecycle", () => {
  it("requests default audio and reports microphone failure details", async () => {
    installWebRtcStubs();
    const onDiagnostic = vi.fn(async () => {});
    const getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error("Microphone access is blocked."), { name: "NotAllowedError" });
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const controller = createLiveVoiceWebController({
      startSession: vi.fn(async () => ({ kind: "rejected" as const })),
      stopSession: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      onState: vi.fn(async (_state: MobileLiveVoiceState) => {}),
      onDiagnostic,
    });

    await controller.start(origin);

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(onDiagnostic).toHaveBeenCalledWith({
      step: "microphone",
      outcome: "permission-denied",
      elapsedMs: expect.any(Number),
      errorName: "NotAllowedError",
      errorMessage: "Microphone access is blocked.",
    });
  });

  it("ends startup when microphone permission never resolves and releases a late stream", async () => {
    const microphone = deferred<FakeStream>();
    let startupTimeout: (() => void) | undefined;
    const getUserMedia = vi.fn(() => microphone.promise);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback: () => void) => {
        startupTimeout = callback;
        return 1;
      }),
      clearTimeout: vi.fn(),
    });
    const startSession = vi.fn(async () => ({
      kind: "started" as const,
      response: { sessionId: origin.sessionId, sdpAnswer: "answer" },
    }));
    const onState = vi.fn(async (_state: MobileLiveVoiceState) => {});
    const controller = createLiveVoiceWebController({
      startSession,
      stopSession: vi.fn(async () => {}),
      sendText: vi.fn(async () => {}),
      onState,
    });

    const starting = controller.start(origin);
    expect(getUserMedia).toHaveBeenCalledOnce();
    startupTimeout?.();
    expect(startSession).not.toHaveBeenCalled();
    const stream = new FakeStream();
    microphone.resolve(stream);
    await starting;

    expect(stream.track.stopped).toBe(true);
    await vi.waitFor(() =>
      expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "error", error: "unavailable" }),
    );
  });

  it("cancels before microphone permission resolves and releases the late stream without starting a host lease", async () => {
    const microphone = deferred<FakeStream>();
    const getUserMedia = vi.fn(() => microphone.promise);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("window", {
      AudioContext: FakeAudioContext,
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    });
    const startSession = vi.fn(async () => ({
      kind: "started" as const,
      response: { sessionId: origin.sessionId, sdpAnswer: "answer" },
    }));
    const stopSession = vi.fn(async () => {});
    const controller = createLiveVoiceWebController({
      startSession,
      stopSession,
      sendText: vi.fn(async () => {}),
      onState: vi.fn(async (_state: MobileLiveVoiceState) => {}),
    });

    const starting = controller.start(origin);
    expect(getUserMedia).toHaveBeenCalledOnce();
    controller.stop();
    const stream = new FakeStream();
    microphone.resolve(stream);
    await starting;

    expect(stream.track.stopped).toBe(true);
    expect(startSession).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("stops a host session accepted after the user already canceled the pending start", async () => {
    installWebRtcStubs();
    const startResponse = deferred<{ sessionId: string; sdpAnswer: string }>();
    const stopSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("stop arrived before start"))
      .mockResolvedValueOnce(undefined);
    const onState = vi.fn(async (_state: MobileLiveVoiceState) => {});
    const actions: LiveVoiceWebActions = {
      startSession: vi.fn(async () => ({ kind: "started" as const, response: await startResponse.promise })),
      stopSession,
      sendText: vi.fn(async () => {}),
      onState,
    };
    const controller = createLiveVoiceWebController(actions);
    const start = controller.start(origin);
    await vi.waitFor(() => expect(actions.startSession).toHaveBeenCalledTimes(1));

    controller.stop();
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onState.mock.calls.some(([state]) => state.phase === "error")).toBe(true));

    startResponse.resolve({ sessionId: origin.sessionId, sdpAnswer: "answer" });
    await start;

    expect(actions.startSession).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenNthCalledWith(2, {
      serverId: origin.target.serverId,
      agentId: origin.target.agentId,
      threadId: origin.target.threadId,
      sessionId: origin.sessionId,
    });
    await vi.waitFor(() =>
      expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "idle", hostSessionActive: false }),
    );
  });

  it("issues a post-acceptance stop when an earlier stop succeeded before the start response", async () => {
    installWebRtcStubs();
    const startResponse = deferred<{ sessionId: string; sdpAnswer: string }>();
    const stopSession = vi.fn(async () => {});
    const actions: LiveVoiceWebActions = {
      startSession: vi.fn(async () => ({ kind: "started" as const, response: await startResponse.promise })),
      stopSession,
      sendText: vi.fn(async () => {}),
      onState: vi.fn(async (_state: MobileLiveVoiceState) => {}),
    };
    const controller = createLiveVoiceWebController(actions);
    const starting = controller.start(origin);
    await vi.waitFor(() => expect(actions.startSession).toHaveBeenCalledTimes(1));

    controller.stop();
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledTimes(1));
    startResponse.resolve({ sessionId: origin.sessionId, sdpAnswer: "answer" });
    await starting;

    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenLastCalledWith({
      serverId: origin.target.serverId,
      agentId: origin.target.agentId,
      threadId: origin.target.threadId,
      sessionId: origin.sessionId,
    });
  });

  it("does not repeat a stop already confirmed for the accepted session", async () => {
    installWebRtcStubs();
    const remoteDescription = deferred<void>();
    const remoteDescriptionStarted = deferred<void>();
    vi.spyOn(FakePeer.prototype, "setRemoteDescription").mockImplementation(async () => {
      remoteDescriptionStarted.resolve(undefined);
      await remoteDescription.promise;
    });
    const stopSession = vi.fn(async () => {});
    const actions: LiveVoiceWebActions = {
      startSession: vi.fn(async () => ({
        kind: "started" as const,
        response: { sessionId: origin.sessionId, sdpAnswer: "answer" },
      })),
      stopSession,
      sendText: vi.fn(async () => {}),
      onState: vi.fn(async (_state: MobileLiveVoiceState) => {}),
    };
    const controller = createLiveVoiceWebController(actions);
    const starting = controller.start(origin);
    await remoteDescriptionStarted.promise;

    controller.stop();
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledOnce());
    remoteDescription.resolve(undefined);
    await starting;

    expect(stopSession).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledWith({
      serverId: origin.target.serverId,
      agentId: origin.target.agentId,
      threadId: origin.target.threadId,
      sessionId: origin.sessionId,
    });
  });

  it("releases a late accepted host lease after the DOM controller is disposed", async () => {
    installWebRtcStubs();
    const startResponse = deferred<{ sessionId: string; sdpAnswer: string }>();
    const stopSession = vi.fn(async () => {});
    const actions: LiveVoiceWebActions = {
      startSession: vi.fn(async () => ({ kind: "started" as const, response: await startResponse.promise })),
      stopSession,
      sendText: vi.fn(async () => {}),
      onState: vi.fn(async (_state: MobileLiveVoiceState) => {}),
    };
    const controller = createLiveVoiceWebController(actions);
    const start = controller.start(origin);
    await vi.waitFor(() => expect(actions.startSession).toHaveBeenCalledTimes(1));
    controller.dispose();
    startResponse.resolve({ sessionId: origin.sessionId, sdpAnswer: "answer" });
    await start;

    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(stopSession).toHaveBeenCalledWith({
      serverId: origin.target.serverId,
      agentId: origin.target.agentId,
      threadId: origin.target.threadId,
      sessionId: origin.sessionId,
    });
  });

  it("clears a definitive start refusal without retaining a nonexistent host lease", async () => {
    installWebRtcStubs();
    const stopSession = vi.fn(async () => {});
    const onState = vi.fn(async (_state: MobileLiveVoiceState) => {});
    const rejectedOutcome = parseRejectedOutcome(JSON.stringify({ kind: "rejected" }));
    const controller = createLiveVoiceWebController({
      startSession: vi.fn(async () => rejectedOutcome),
      stopSession,
      sendText: vi.fn(async () => {}),
      onState,
    });

    await controller.start(origin);

    expect(stopSession).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({
        phase: "error",
        hostSessionActive: false,
        error: "unavailable",
      }),
    );
  });

  it("keeps typed input disabled until the WebRTC connection is live", async () => {
    installWebRtcStubs();
    const sendText = vi.fn(async () => {});
    const onState = vi.fn(async (_state: MobileLiveVoiceState) => {});
    const controller = createLiveVoiceWebController({
      startSession: vi.fn(async () => ({
        kind: "started" as const,
        response: { sessionId: origin.sessionId, sdpAnswer: "answer" },
      })),
      stopSession: vi.fn(async () => {}),
      sendText,
      onState,
    });

    await controller.start(origin);
    await expect(controller.sendText("hello")).rejects.toThrow("not ready");
    expect(sendText).not.toHaveBeenCalled();

    FakePeer.instances[0]?.connect();
    await vi.waitFor(() => expect(onState.mock.calls.some(([state]) => state.phase === "live")).toBe(true));
    await controller.sendText("hello");
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});

function isRejectedOutcome(value: unknown): value is { kind: "rejected" } {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "rejected";
}

function parseRejectedOutcome(serialized: string): { kind: "rejected" } {
  const value = JSON.parse(serialized);
  if (!isRejectedOutcome(value)) throw new Error("The serialized rejection outcome changed shape.");
  return value;
}
