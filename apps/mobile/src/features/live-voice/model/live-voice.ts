import type { AvatarHue } from "@openbot/contracts/ipc";
import type { LiveVoiceWireEvent } from "@openbot/contracts/team-protocol/live-voice-v1";

export type MobileLiveVoicePhase = "idle" | "connecting" | "live" | "stopping" | "error";

export interface MobileLiveVoiceTarget {
  serverId: string;
  agentId: string;
  threadId: string;
  channelId?: string;
  agentName: string;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
}

export interface MobileLiveVoiceState {
  phase: MobileLiveVoicePhase;
  sessionId: string | null;
  hostSessionActive: boolean;
  muted: boolean;
  audioBlocked: boolean;
  microphoneBlocked: boolean;
  microphoneLevels: number[];
  playbackLevels: number[];
  elapsedMs: number;
  error?: string;
}

export interface MobileLiveVoiceOrigin {
  target: MobileLiveVoiceTarget;
  sessionId: string;
}

export interface LiveVoiceStartActionIdentity {
  serverId: string;
  agentId: string;
  threadId: string;
  channelId?: string;
  clientSessionId: string;
}

export interface LiveVoiceStartActionContext {
  mounted: boolean;
  foreground: boolean;
  activeServerId: string;
  serverOnline: boolean;
  sessionPhase: MobileLiveVoicePhase;
  hostSessionActive: boolean;
  supported: boolean;
}

export const EMPTY_LIVE_VOICE_STATE: MobileLiveVoiceState = {
  phase: "idle",
  sessionId: null,
  hostSessionActive: false,
  muted: false,
  audioBlocked: false,
  microphoneBlocked: false,
  microphoneLevels: Array(16).fill(0),
  playbackLevels: Array(16).fill(0),
  elapsedMs: 0,
};

export function isLiveVoiceBusy(state: Pick<MobileLiveVoiceState, "phase" | "hostSessionActive">): boolean {
  return (
    state.hostSessionActive || state.phase === "connecting" || state.phase === "live" || state.phase === "stopping"
  );
}

/** A call owns one exact conversation. A channel and its lead agent's direct chat are different origins. */
export function routesComposerToLiveVoice(
  origin: MobileLiveVoiceOrigin | null,
  composer: Pick<MobileLiveVoiceTarget, "serverId" | "agentId" | "threadId" | "channelId"> | null,
  state: Pick<MobileLiveVoiceState, "phase" | "hostSessionActive">,
): boolean {
  if (!origin || !composer || !isLiveVoiceBusy(state)) return false;
  return (
    composer.serverId === origin.target.serverId &&
    composer.agentId === origin.target.agentId &&
    composer.threadId === origin.target.threadId &&
    composer.channelId === origin.target.channelId
  );
}

export function matchesLiveVoiceHostEvent(
  origin: MobileLiveVoiceOrigin | null,
  serverId: string,
  event: LiveVoiceWireEvent,
): boolean {
  return Boolean(
    origin &&
      origin.target.serverId === serverId &&
      origin.sessionId === event.sessionId &&
      origin.target.agentId === event.agentId &&
      origin.target.threadId === event.threadId,
  );
}

export function sameLiveVoiceTarget(a: MobileLiveVoiceTarget, b: MobileLiveVoiceTarget): boolean {
  return (
    a.serverId === b.serverId && a.agentId === b.agentId && a.threadId === b.threadId && a.channelId === b.channelId
  );
}

/** Reject a queued DOM start action if its session or workspace context is stale. */
export function isCurrentLiveVoiceStartAction(
  origin: MobileLiveVoiceOrigin | null,
  request: LiveVoiceStartActionIdentity,
  context: LiveVoiceStartActionContext,
): boolean {
  return Boolean(
    origin &&
      context.mounted &&
      context.foreground &&
      context.activeServerId === request.serverId &&
      context.serverOnline &&
      context.sessionPhase === "connecting" &&
      !context.hostSessionActive &&
      context.supported &&
      origin.sessionId === request.clientSessionId &&
      origin.target.serverId === request.serverId &&
      origin.target.agentId === request.agentId &&
      origin.target.threadId === request.threadId &&
      origin.target.channelId === request.channelId,
  );
}
