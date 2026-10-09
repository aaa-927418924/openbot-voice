import { describe, expect, it } from "vitest";
import {
  createLiveVoiceDomDiagnostic,
  formatLiveVoiceDomDiagnostic,
  LIVE_VOICE_DIAGNOSTIC_BUILD_ID,
  parseLiveVoiceDomDiagnostic,
} from "./live-voice-dom-diagnostic";

describe("Live Voice DOM diagnostics", () => {
  it("formats the build ID and safe command-delivery state", () => {
    const message = createLiveVoiceDomDiagnostic({
      stage: "props-updated",
      active: true,
      hasSessionId: true,
      commandCount: 1,
      commandTypes: ["start"],
    });

    expect(formatLiveVoiceDomDiagnostic(message)).toBe(
      `Live Voice probe [${LIVE_VOICE_DIAGNOSTIC_BUILD_ID}]: props-updated (active=true; hasSessionId=true; commandCount=1; commands=start)`,
    );
    expect(parseLiveVoiceDomDiagnostic(JSON.stringify(message))).toEqual(message);
  });

  it("rejects stale builds, unrelated messages, and payload fields that could expose session data", () => {
    expect(parseLiveVoiceDomDiagnostic("not-json")).toBeNull();
    expect(parseLiveVoiceDomDiagnostic(JSON.stringify({ type: "other-message" }))).toBeNull();
    expect(
      parseLiveVoiceDomDiagnostic(
        JSON.stringify({
          type: "openbot-live-voice-diagnostic",
          buildId: "older-build",
          stage: "dom-mounted",
        }),
      ),
    ).toBeNull();
    expect(
      parseLiveVoiceDomDiagnostic(
        JSON.stringify({
          ...createLiveVoiceDomDiagnostic({ stage: "start-command-received" }),
          sessionId: "private-session-id",
        }),
      ),
    ).toBeNull();
  });
});
