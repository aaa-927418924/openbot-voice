import type { ChannelMember } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import { describe, expect, it } from "vitest";
import { channelLiveVoiceTarget } from "./channel-live-voice";

const agent: Pick<AgentProfile, "id" | "name" | "provider" | "threadId" | "avatarSeed" | "avatarHue" | "avatarUrl"> = {
  id: "agent-a",
  name: "Codex",
  provider: "codex",
  threadId: "thread-a",
  avatarSeed: "codex",
  avatarHue: null,
  avatarUrl: null,
};
const members: ChannelMember[] = [{ agentId: agent.id }];
const supported = {
  channelId: "channel-a",
  serverId: "local",
  members,
  agents: [agent],
  isWindowsDesktop: true,
  available: true,
  serverSupportsLiveVoice: true,
};

describe("channel Live voice eligibility", () => {
  it("returns the single resolved Codex thread when the platform and server support Live voice", () => {
    expect(channelLiveVoiceTarget(supported)).toEqual({
      channelId: "channel-a",
      serverId: "local",
      agentId: "agent-a",
      threadId: "thread-a",
      agent: {
        id: agent.id,
        name: agent.name,
        provider: agent.provider,
        avatarSeed: agent.avatarSeed,
        avatarHue: agent.avatarHue,
        avatarUrl: agent.avatarUrl,
      },
    });
  });

  it("requires exactly one channel member", () => {
    expect(channelLiveVoiceTarget({ ...supported, members: [] })).toBeUndefined();
    expect(channelLiveVoiceTarget({ ...supported, members: [...members, { agentId: "agent-b" }] })).toBeUndefined();
  });

  it("requires the member to resolve to a Codex agent with an existing thread", () => {
    expect(channelLiveVoiceTarget({ ...supported, agents: [] })).toBeUndefined();
    expect(channelLiveVoiceTarget({ ...supported, agents: [{ ...agent, provider: "claude" }] })).toBeUndefined();
    expect(channelLiveVoiceTarget({ ...supported, agents: [{ ...agent, threadId: null }] })).toBeUndefined();
  });

  it("requires the Windows Live voice API and a server that advertises support", () => {
    expect(channelLiveVoiceTarget({ ...supported, isWindowsDesktop: false })).toBeUndefined();
    expect(channelLiveVoiceTarget({ ...supported, available: false })).toBeUndefined();
    expect(channelLiveVoiceTarget({ ...supported, serverSupportsLiveVoice: false })).toBeUndefined();
  });
});
