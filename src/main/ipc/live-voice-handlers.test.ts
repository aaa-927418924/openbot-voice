import { describe, expect, it } from "vitest";
import { type LiveVoiceWindow, requireLiveVoiceWindowSender } from "./live-voice-handlers";

describe("Live voice sender authorization", () => {
  it("accepts only the current main window and rejects destroyed or replaced windows", () => {
    let destroyed = false;
    const window: LiveVoiceWindow = { isDestroyed: () => destroyed, webContents: { id: 41 } };

    expect(() => requireLiveVoiceWindowSender(41, window)).not.toThrow();
    expect(() => requireLiveVoiceWindowSender(42, window)).toThrow();
    destroyed = true;
    expect(() => requireLiveVoiceWindowSender(41, window)).toThrow();
    expect(() => requireLiveVoiceWindowSender(41, null)).toThrow();
  });
});
