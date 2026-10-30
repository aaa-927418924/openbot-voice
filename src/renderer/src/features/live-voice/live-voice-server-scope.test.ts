import { describe, expect, it } from "vitest";
import type { LiveVoiceState } from "./live-voice-controller";
import { shouldStopLiveVoiceForMissingServer } from "./live-voice-server-scope";

const connecting: LiveVoiceState = {
  phase: "connecting",
  audioBlocked: false,
  microphoneBlocked: false,
  hostSessionActive: false,
  stopPending: false,
  muted: false,
  microphoneLevels: [],
  playbackLevels: [],
};

describe("Live Voice server scope", () => {
  it("waits for the server list before treating a missing origin as removed", () => {
    expect(shouldStopLiveVoiceForMissingServer("local", [], false, connecting)).toBe(false);
    expect(shouldStopLiveVoiceForMissingServer("local", [], true, connecting)).toBe(true);
  });

  it("keeps a session while its origin server remains configured", () => {
    expect(shouldStopLiveVoiceForMissingServer("remote", [{ id: "remote" }], true, connecting)).toBe(false);
  });

  it("does not restart or stop an already idle or failed voice session", () => {
    expect(shouldStopLiveVoiceForMissingServer("local", [], true, { ...connecting, phase: "idle" })).toBe(false);
    expect(shouldStopLiveVoiceForMissingServer("local", [], true, { ...connecting, phase: "error" })).toBe(false);
  });
});
