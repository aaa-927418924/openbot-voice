import type { ChannelMember } from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import type { LiveVoiceOrigin } from "../live-voice/live-voice-context";

type ChannelLiveVoiceAgent = Pick<
  AgentProfile,
  "id" | "name" | "provider" | "threadId" | "avatarSeed" | "avatarHue" | "avatarUrl"
>;

export function channelLiveVoiceTarget(input: {
  channelId: string | undefined;
  serverId: string | undefined;
  members: readonly ChannelMember[];
  agents: readonly ChannelLiveVoiceAgent[];
  isWindowsDesktop: boolean;
  available: boolean;
  serverSupportsLiveVoice: boolean;
}): LiveVoiceOrigin | undefined {
  if (
    !input.channelId ||
    !input.serverId ||
    !input.isWindowsDesktop ||
    !input.available ||
    !input.serverSupportsLiveVoice ||
    input.members.length !== 1
  ) {
    return undefined;
  }
  const member = input.members[0];
  const agent = input.agents.find((candidate) => candidate.id === member?.agentId);
  if (agent?.provider !== "codex" || !agent.threadId) return undefined;
  return {
    channelId: input.channelId,
    serverId: input.serverId,
    agentId: agent.id,
    threadId: agent.threadId,
    agent: {
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      avatarSeed: agent.avatarSeed,
      avatarHue: agent.avatarHue,
      avatarUrl: agent.avatarUrl,
    },
  };
}
