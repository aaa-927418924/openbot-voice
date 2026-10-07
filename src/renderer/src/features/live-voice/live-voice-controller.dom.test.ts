import type { LiveVoiceEvent, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveVoiceController, type LiveVoiceState } from "./live-voice-controller";

type LiveVoiceApi = Pick<OpenBotDesktopApi["liveVoice"], "start" | "stop" | "onEvent" | "sendText">;

class TestAudio {
  autoplay = false;
  srcObject: MediaStream | null = null;
  readonly play = vi.fn(async () => undefined);
}

class TestPeer extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: { sdp: string } | null = null;
  readonly addTrack = vi.fn();
  readonly close = vi.fn();
  readonly createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "v=0\r\n" }));
  readonly setLocalDescription = vi.fn(async (offer: RTCSessionDescriptionInit) => {
    this.localDescription = { sdp: offer.sdp ?? "" };
  });
  readonly setRemoteDescription = vi.fn(async () => undefined);
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
}

const target = { agentId: "agent-1", threadId: "thread-1", serverId: "local" };
const stopPayload = { agentId: target.agentId, threadId: target.threadId };
const tracks = [{ stop: vi.fn() }];
const stream = {
  getTracks: () => tracks,
  getAudioTracks: () => tracks,
};

let emitEvent: ((event: LiveVoiceEvent) => void) | undefined;
let states: LiveVoiceState[];
let api: LiveVoiceApi;
let controller: ReturnType<typeof createLiveVoiceController>;
let startDeferred: { resolve: (value: { sessionId: string; sdpAnswer: string }) => void } | undefined;

beforeEach(() => {
  vi.stubGlobal("Audio", TestAudio);
  vi.stubGlobal("RTCPeerConnection", TestPeer);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
  emitEvent = undefined;
  states = [];
  startDeferred = undefined;
  api = {
    start: vi.fn<LiveVoiceApi["start"]>(async (input) => {
      const deferred = startDeferred;
      if (deferred) return await new Promise((resolve) => (deferred.resolve = resolve));
      return { sessionId: input.clientSessionId, sdpAnswer: "v=0\r\n" };
    }),
    stop: vi.fn<LiveVoiceApi["stop"]>(async () => undefined),
    sendText: vi.fn<LiveVoiceApi["sendText"]>(async () => undefined),
    onEvent: vi.fn<LiveVoiceApi["onEvent"]>((listener) => {
      emitEvent = listener;
      return () => {
        emitEvent = undefined;
      };
    }),
  };
  controller = createLiveVoiceController(api, (state) => states.push(state));
});

afterEach(() => {
  controller.dispose();
  vi.unstubAllGlobals();
});

describe("Live voice media lifecycle", () => {
  it("stops local media immediately and holds the session token until a late close event", async () => {
    startDeferred = { resolve: () => undefined };
    const starting = controller.start(target);
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    const request = vi.mocked(api.start).mock.calls[0]?.[0];
    if (!request) throw new Error("The host start request was not created.");

    await controller.stop();
    expect(tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(api.stop).toHaveBeenCalledWith({ ...stopPayload, sessionId: request.clientSessionId }, target.serverId);
    expect(states.at(-1)).toMatchObject({ phase: "stopping", hostSessionActive: true });

    startDeferred.resolve({ sessionId: request.clientSessionId, sdpAnswer: "v=0\r\n" });
    await starting;
    await controller.start(target);
    expect(api.start).toHaveBeenCalledOnce();

    emitEvent?.({ ...stopPayload, sessionId: request.clientSessionId, status: "closed" });
    expect(states.at(-1)).toMatchObject({ phase: "idle", hostSessionActive: false });
  });

  it("keeps a failed stop retryable and blocks a new session until closed", async () => {
    api.stop = vi
      .fn<LiveVoiceApi["stop"]>(async () => undefined)
      .mockRejectedValueOnce(new Error("Stop could not be confirmed."));
    await controller.start(target);
    const request = vi.mocked(api.start).mock.calls[0]?.[0];
    if (!request) throw new Error("The host start request was not created.");
    await controller.stop();
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalled());
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ phase: "error", hostSessionActive: true }));

    await controller.start(target);
    expect(api.start).toHaveBeenCalledOnce();

    await controller.stop();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ phase: "stopping", hostSessionActive: true }));
    emitEvent?.({ ...stopPayload, sessionId: request.clientSessionId, status: "closed" });
    expect(states.at(-1)).toMatchObject({ phase: "idle", hostSessionActive: false });
  });

  it("shows a definitive start rejection that arrives after the host closes the token", async () => {
    let rejectStart: ((error: Error) => void) | undefined;
    api.start = vi.fn<LiveVoiceApi["start"]>(() => new Promise((_resolve, reject) => (rejectStart = reject)));
    const starting = controller.start(target);
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    const request = vi.mocked(api.start).mock.calls[0]?.[0];
    if (!request) throw new Error("The host start request was not created.");

    emitEvent?.({ ...stopPayload, sessionId: request.clientSessionId, status: "closed" });
    rejectStart?.(new Error("Codex account is required."));
    await starting;
    expect(states.at(-1)).toMatchObject({ phase: "error", hostSessionActive: false });

    api.start = vi.fn<LiveVoiceApi["start"]>(async (input) => ({
      sessionId: input.clientSessionId,
      sdpAnswer: "v=0\\r\\n",
    }));
    await controller.start(target);
    expect(api.start).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ phase: "connecting" });
  });
});
