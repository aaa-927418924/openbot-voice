import { describe, expect, it } from "vitest";
import {
  LIVE_VOICE_SESSION_END_ITEM_TYPE,
  LIVE_VOICE_SESSION_START_ITEM_TYPE,
  parseLiveVoiceSessionMarker,
} from "./ipc-live-voice";

const sessionHash = "a".repeat(48);

describe("parseLiveVoiceSessionMarker", () => {
  it("reads start and end records from existing message fields", () => {
    expect(
      parseLiveVoiceSessionMarker({
        id: `livevoice-${sessionHash}-start`,
        itemType: LIVE_VOICE_SESSION_START_ITEM_TYPE,
        author: "system",
        text: "",
      }),
    ).toEqual({ sessionKey: sessionHash, action: "started" });
    expect(
      parseLiveVoiceSessionMarker({
        id: `livevoice-${sessionHash}-end`,
        itemType: `${LIVE_VOICE_SESSION_END_ITEM_TYPE}:12500`,
        author: "system",
        text: "",
      }),
    ).toEqual({ sessionKey: sessionHash, action: "ended", durationMs: 12500 });
  });

  it.each([
    { id: "livevoice-not-a-hash-start", itemType: LIVE_VOICE_SESSION_START_ITEM_TYPE },
    { id: `livevoice-${sessionHash}-end`, itemType: LIVE_VOICE_SESSION_END_ITEM_TYPE },
    { id: `livevoice-${sessionHash}-end`, itemType: `${LIVE_VOICE_SESSION_END_ITEM_TYPE}:-1` },
    { id: `livevoice-${sessionHash}-start`, itemType: `${LIVE_VOICE_SESSION_END_ITEM_TYPE}:100` },
    {
      id: `livevoice-${sessionHash}-start`,
      itemType: LIVE_VOICE_SESSION_START_ITEM_TYPE,
      author: "assistant",
      text: "x",
    },
  ])("ignores a malformed marker: $itemType", (message) => {
    expect(parseLiveVoiceSessionMarker(message)).toBeUndefined();
  });
});
