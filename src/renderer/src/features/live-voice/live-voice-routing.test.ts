import { describe, expect, it } from "vitest";
import type { LiveVoiceOrigin } from "./live-voice-context";
import { routesComposerToLiveVoice } from "./live-voice-routing";

const origin: LiveVoiceOrigin = {
  agentId: "agent-a",
  threadId: "thread-a",
  serverId: "local",
  agent: {
    id: "agent-a",
    name: "Codex",
    provider: "codex",
    avatarSeed: "codex",
    avatarHue: null,
    avatarUrl: null,
  },
};
const target = { agentId: "agent-a", threadId: "thread-a", serverId: "local" };

describe("live voice composer routing", () => {
  it("routes only the exact origin while the host session owns its lease", () => {
    expect(routesComposerToLiveVoice(origin, target, { phase: "live", hostSessionActive: true })).toBe(true);
    expect(
      routesComposerToLiveVoice(
        origin,
        { ...target, threadId: "thread-b" },
        { phase: "live", hostSessionActive: true },
      ),
    ).toBe(false);
  });

  it("returns to normal conversation delivery after the host confirms closure", () => {
    expect(routesComposerToLiveVoice(origin, target, { phase: "idle", hostSessionActive: false })).toBe(false);
  });

  it("routes direct chats for the exact agent thread and channels only for the origin channel", () => {
    const channelOrigin = { ...origin, channelId: "channel-a" };
    const channelTarget = { ...target, channelId: "channel-a" };
    const active = { phase: "live" as const, hostSessionActive: true };
    expect(routesComposerToLiveVoice(channelOrigin, channelTarget, active)).toBe(true);
    expect(routesComposerToLiveVoice(channelOrigin, { ...channelTarget, channelId: "channel-b" }, active)).toBe(false);
    expect(routesComposerToLiveVoice(channelOrigin, target, active)).toBe(true);
    expect(routesComposerToLiveVoice(origin, channelTarget, active)).toBe(false);
  });
});
