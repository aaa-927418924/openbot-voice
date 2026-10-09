import { describe, expect, it } from "vitest";
import { isDefinitiveLiveVoiceStartRefusalStatus } from "./live-voice-host";

describe("Live Voice host start status", () => {
  it("classifies only known pre-lease refusal statuses as definitive", () => {
    for (const status of [400, 401, 403, 404, 409]) {
      expect(isDefinitiveLiveVoiceStartRefusalStatus(status)).toBe(true);
    }
    for (const status of [408, 422, 429, 500, 502, 503]) {
      expect(isDefinitiveLiveVoiceStartRefusalStatus(status)).toBe(false);
    }
  });
});
