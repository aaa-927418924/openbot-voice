import { describe, expect, it } from "vitest";
import {
  EMPTY_LIVE_VOICE_STATE,
  isCurrentLiveVoiceStartAction,
  type MobileLiveVoiceOrigin,
  type MobileLiveVoiceTarget,
  matchesLiveVoiceHostEvent,
  routesComposerToLiveVoice,
  sameLiveVoiceTarget,
} from "./live-voice";

const target: MobileLiveVoiceTarget = {
  serverId: "server-a",
  agentId: "agent-a",
  threadId: "thread-a",
  agentName: "Codex",
  avatarSeed: "codex",
  avatarHue: null,
};
const origin: MobileLiveVoiceOrigin = { target, sessionId: "session-a" };
const event = {
  type: "live-voice" as const,
  agentId: target.agentId,
  threadId: target.threadId,
  sessionId: origin.sessionId,
  status: "closed" as const,
};

describe("mobile Live Voice conversation ownership", () => {
  it("routes only the exact active direct conversation", () => {
    expect(routesComposerToLiveVoice(origin, target, { phase: "live", hostSessionActive: true })).toBe(true);
    expect(
      routesComposerToLiveVoice(
        origin,
        { ...target, threadId: "thread-b" },
        { phase: "live", hostSessionActive: true },
      ),
    ).toBe(false);
    expect(
      routesComposerToLiveVoice(
        origin,
        { ...target, serverId: "server-b" },
        { phase: "live", hostSessionActive: true },
      ),
    ).toBe(false);
    expect(
      routesComposerToLiveVoice(origin, { ...target, agentId: "agent-b" }, { phase: "live", hostSessionActive: true }),
    ).toBe(false);
  });

  it("keeps a channel call distinct from its direct conversation and releases routing after close", () => {
    const channelTarget = { ...target, channelId: "channel-a" };
    const channelOrigin = { target: channelTarget, sessionId: origin.sessionId };
    expect(
      routesComposerToLiveVoice(channelOrigin, channelTarget, { phase: "connecting", hostSessionActive: false }),
    ).toBe(true);
    expect(routesComposerToLiveVoice(channelOrigin, target, { phase: "live", hostSessionActive: true })).toBe(false);
    expect(routesComposerToLiveVoice(origin, target, EMPTY_LIVE_VOICE_STATE)).toBe(false);
  });

  it("accepts only lifecycle events for the current server, agent, thread, and session", () => {
    expect(matchesLiveVoiceHostEvent(origin, target.serverId, event)).toBe(true);
    expect(matchesLiveVoiceHostEvent(origin, "server-b", event)).toBe(false);
    expect(matchesLiveVoiceHostEvent(origin, target.serverId, { ...event, sessionId: "session-b" })).toBe(false);
    expect(matchesLiveVoiceHostEvent(origin, target.serverId, { ...event, threadId: "thread-b" })).toBe(false);
    expect(matchesLiveVoiceHostEvent(null, target.serverId, event)).toBe(false);
  });

  it("rejects queued native start actions after their origin or workspace context changes", () => {
    const request = {
      serverId: target.serverId,
      agentId: target.agentId,
      threadId: target.threadId,
      clientSessionId: origin.sessionId,
    };
    const context = {
      mounted: true,
      foreground: true,
      activeServerId: target.serverId,
      serverOnline: true,
      sessionPhase: "connecting" as const,
      hostSessionActive: false,
      supported: true,
    };

    expect(isCurrentLiveVoiceStartAction(origin, request, context)).toBe(true);
    expect(isCurrentLiveVoiceStartAction(origin, { ...request, clientSessionId: "old-session" }, context)).toBe(false);
    expect(isCurrentLiveVoiceStartAction(origin, request, { ...context, mounted: false })).toBe(false);
    expect(isCurrentLiveVoiceStartAction(origin, request, { ...context, activeServerId: "other-server" })).toBe(false);
    expect(isCurrentLiveVoiceStartAction(origin, request, { ...context, foreground: false })).toBe(false);
    expect(isCurrentLiveVoiceStartAction(origin, request, { ...context, sessionPhase: "stopping" })).toBe(false);

    const channelOrigin = { ...origin, target: { ...target, channelId: "channel-a" } };
    expect(isCurrentLiveVoiceStartAction(channelOrigin, request, context)).toBe(false);
    expect(isCurrentLiveVoiceStartAction(channelOrigin, { ...request, channelId: "channel-a" }, context)).toBe(true);
  });

  it("compares only the pinned routing identity", () => {
    expect(sameLiveVoiceTarget(target, { ...target, agentName: "New label", avatarHue: 30 })).toBe(true);
    expect(sameLiveVoiceTarget(target, { ...target, channelId: "channel-a" })).toBe(false);
  });
});
