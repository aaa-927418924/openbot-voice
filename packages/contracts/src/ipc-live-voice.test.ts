import { describe, expect, it } from "vitest";
import {
  CODEX_LIVE_VOICES,
  DEFAULT_CODEX_LIVE_VOICE,
  isCodexLiveVoice,
  LIVE_VOICE_SESSION_END_ITEM_TYPE,
  LIVE_VOICE_SESSION_START_ITEM_TYPE,
  parseLiveVoiceSessionMarker,
} from "./ipc-live-voice";

const sessionHash = "a".repeat(48);

describe("Codex Live voices", () => {
  it("matches the voices accepted by app-server realtime v3", () => {
    expect(CODEX_LIVE_VOICES).toEqual([
      "juniper",
      "maple",
      "spruce",
      "ember",
      "vale",
      "breeze",
      "arbor",
      "sol",
      "cove",
    ]);
    expect(DEFAULT_CODEX_LIVE_VOICE).toBe("juniper");
    expect(CODEX_LIVE_VOICES.every(isCodexLiveVoice)).toBe(true);
    expect(isCodexLiveVoice("marin")).toBe(false);
  });
});

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
