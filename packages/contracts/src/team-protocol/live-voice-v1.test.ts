import { describe, expect, it } from "vitest";
import { TEAM_CURRENT_CAPABILITIES } from "./current";
import { LIVE_VOICE_CAPABILITY, LIVE_VOICE_ROUTES, liveVoiceEvent } from "./live-voice-v1";
import { optionalRouteCodec } from "./optional-routes";

const offer = {
  agentId: "agent-1",
  threadId: "thread-1",
  clientSessionId: "session-1",
  sdpOffer: "v=0\r\n",
};

function codec(path: string) {
  const found = optionalRouteCodec(path);
  if (!found) throw new Error(`No codec for ${path}.`);
  return found;
}

describe("live-voice-v1", () => {
  it("advertises one additive capability and registers the three session routes", () => {
    expect(TEAM_CURRENT_CAPABILITIES).toContain(LIVE_VOICE_CAPABILITY);
    expect(codec(LIVE_VOICE_ROUTES.start).request({ ...offer, ignored: true })).toEqual(offer);
    expect(
      codec(LIVE_VOICE_ROUTES.start).response(200, {
        sessionId: "session-1",
        sdpAnswer: "v=0\r\n",
        ignored: true,
      }),
    ).toEqual({ sessionId: "session-1", sdpAnswer: "v=0\r\n" });
    expect(codec(LIVE_VOICE_ROUTES.stop).request({ ...offer, sessionId: "session-1" })).toEqual({
      agentId: "agent-1",
      threadId: "thread-1",
      sessionId: "session-1",
    });
    expect(
      codec(LIVE_VOICE_ROUTES.sendText).request({
        agentId: "agent-1",
        threadId: "thread-1",
        sessionId: "session-1",
        text: "Research this URL: https://example.com",
      }),
    ).toEqual({
      agentId: "agent-1",
      threadId: "thread-1",
      sessionId: "session-1",
      text: "Research this URL: https://example.com",
    });
    expect(codec(LIVE_VOICE_ROUTES.stop).response(200, { ignored: true })).toEqual({});
  });

  it("rejects incomplete or unbounded session requests and responses", () => {
    expect(() => codec(LIVE_VOICE_ROUTES.start).request({ ...offer, threadId: "" })).toThrow();
    expect(() => codec(LIVE_VOICE_ROUTES.start).request({ ...offer, sdpOffer: "x".repeat(256_001) })).toThrow();
    expect(() => codec(LIVE_VOICE_ROUTES.start).response(200, { sessionId: "session-1" })).toThrow();
    expect(() =>
      codec(LIVE_VOICE_ROUTES.sendText).request({
        agentId: "agent-1",
        threadId: "thread-1",
        sessionId: "session-1",
        text: "x".repeat(128_001),
      }),
    ).toThrow();
  });

  it("decodes only valid live-voice lifecycle events and leaves other events to their adapters", () => {
    expect(liveVoiceEvent({ type: "turn-started" })).toBeNull();
    expect(
      liveVoiceEvent({
        type: "live-voice",
        agentId: "agent-1",
        threadId: "thread-1",
        sessionId: "session-1",
        status: "error",
        message: "The host account is unavailable.",
      }),
    ).toEqual({
      type: "live-voice",
      agentId: "agent-1",
      threadId: "thread-1",
      sessionId: "session-1",
      status: "error",
      message: "The host account is unavailable.",
    });
    expect(() => liveVoiceEvent({ type: "live-voice", ...offer, status: "failed" })).toThrow();
    expect(() =>
      liveVoiceEvent({
        type: "live-voice",
        agentId: "agent-1",
        threadId: "thread-1",
        sessionId: "session-1",
        status: "error",
        message: "x".repeat(301),
      }),
    ).toThrow();
  });
});
