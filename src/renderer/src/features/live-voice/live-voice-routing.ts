import type { LiveVoiceOrigin } from "./live-voice-context";
import type { LiveVoiceState } from "./live-voice-controller";

export interface LiveVoiceComposerTarget {
  agentId: string;
  serverId: string;
  threadId: string | null;
}

/** Only the active call's exact origin chat bypasses normal conversation delivery. */
export function routesComposerToLiveVoice(
  origin: LiveVoiceOrigin | undefined,
  target: LiveVoiceComposerTarget | undefined,
  state: Pick<LiveVoiceState, "phase" | "hostSessionActive">,
): boolean {
  if (!origin || !target) return false;
  const sessionOwnsComposer = state.hostSessionActive || state.phase === "connecting" || state.phase === "stopping";
  return (
    sessionOwnsComposer &&
    target.agentId === origin.agentId &&
    target.serverId === origin.serverId &&
    target.threadId === origin.threadId
  );
}
