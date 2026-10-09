import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileLiveVoiceCommandMailbox, MOBILE_LIVE_VOICE_COMMAND_TIMEOUTS_MS } from "./live-voice-command";

afterEach(() => {
  vi.useRealTimers();
});

describe("mobile Live Voice command mailbox", () => {
  it("expires an unacknowledged stop and ignores a late result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let published: { id: string; type: string }[] = [];
    const mailbox = createMobileLiveVoiceCommandMailbox((commands) => {
      published = commands;
    });
    const pending = mailbox.send({ id: "stop", type: "stop" });
    expect(published).toEqual([{ id: "stop", type: "stop" }]);

    await vi.advanceTimersByTimeAsync(MOBILE_LIVE_VOICE_COMMAND_TIMEOUTS_MS.stop);
    await expect(pending).resolves.toMatchObject({ ok: false, error: "timeout" });
    expect(published).toEqual([]);
    mailbox.receive({ commandId: "stop", ok: true });
    expect(published).toEqual([]);
    mailbox.dispose();
  });
});
