import { isBoundedString } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf, isString } from "./runtime-values";

export const LIVE_VOICE_SDP_LIMIT = 256_000;

/** Codex's built-in v2 realtime voices; v3 sessions accept the same configured voice field. */
export const CODEX_LIVE_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
export type CodexLiveVoice = (typeof CODEX_LIVE_VOICES)[number];
export const DEFAULT_CODEX_LIVE_VOICE: CodexLiveVoice = "marin";

export function isCodexLiveVoice(value: unknown): value is CodexLiveVoice {
  return isOneOf(CODEX_LIVE_VOICES, value);
}

export interface LiveVoiceStartInput {
  agentId: string;
  threadId: string;
  clientSessionId: string;
  sdpOffer: string;
  /** Present only for a single-agent channel call. */
  channelId?: string;
}

export interface LiveVoiceStopInput {
  agentId: string;
  threadId: string;
  sessionId: string;
}

export interface LiveVoiceSendTextInput extends LiveVoiceStopInput {
  text: string;
}

export interface LiveVoiceStartResult {
  sessionId: string;
  sdpAnswer: string;
}

/** The IPC result distinguishes a host refusal from a transport error with an unknown session state. */
export type LiveVoiceStartOutcome =
  | { kind: "started"; sessionId: string; sdpAnswer: string }
  | { kind: "refused"; message: string };

export type LiveVoiceStatus = "starting" | "started" | "closed" | "error";

export interface LiveVoiceEvent {
  agentId: string;
  threadId: string;
  sessionId: string;
  status: LiveVoiceStatus;
  message?: string;
  /** The client machine whose agent owns this session. Local service events are unscoped until forwarded. */
  serverId?: string;
}

export function isLiveVoiceStartInput(value: unknown): value is LiveVoiceStartInput {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.agentId, 128) &&
    isBoundedString(value.threadId, 128) &&
    isUuid(value.clientSessionId) &&
    (value.channelId === undefined || isBoundedString(value.channelId, 128)) &&
    isString(value.sdpOffer) &&
    value.sdpOffer.length > 0 &&
    value.sdpOffer.length <= LIVE_VOICE_SDP_LIMIT
  );
}

export function isLiveVoiceStopInput(value: unknown): value is LiveVoiceStopInput {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.agentId, 128) &&
    isBoundedString(value.threadId, 128) &&
    isUuid(value.sessionId)
  );
}

export function isLiveVoiceSendTextInput(value: unknown): value is LiveVoiceSendTextInput {
  const text = isDynamicRecord(value) ? value.text : undefined;
  return isLiveVoiceStopInput(value) && isString(text) && text.trim().length > 0 && text.length <= 128_000;
}

export function isLiveVoiceStartResult(value: unknown): value is LiveVoiceStartResult {
  return (
    isDynamicRecord(value) &&
    isUuid(value.sessionId) &&
    isString(value.sdpAnswer) &&
    value.sdpAnswer.length > 0 &&
    value.sdpAnswer.length <= LIVE_VOICE_SDP_LIMIT
  );
}

export function isLiveVoiceStartOutcome(value: unknown): value is LiveVoiceStartOutcome {
  if (!isDynamicRecord(value)) return false;
  if (value.kind === "started")
    return isLiveVoiceStartResult({ sessionId: value.sessionId, sdpAnswer: value.sdpAnswer });
  return value.kind === "refused" && isBoundedString(value.message, 300);
}

export function isLiveVoiceEvent(value: unknown): value is LiveVoiceEvent {
  const serverId = isDynamicRecord(value) ? value.serverId : undefined;
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.agentId, 128) &&
    isBoundedString(value.threadId, 128) &&
    isUuid(value.sessionId) &&
    isOneOf(["starting", "started", "closed", "error"] as const, value.status) &&
    (value.message === undefined || isBoundedString(value.message, 300)) &&
    (serverId === undefined || isBoundedString(serverId, 128))
  );
}

function isUuid(value: unknown): value is string {
  return isString(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export const LIVE_VOICE_SESSION_START_ITEM_TYPE = "live-voice-session-start";
export const LIVE_VOICE_SESSION_END_ITEM_TYPE = "live-voice-session-end";

export interface LiveVoiceSessionMarker {
  sessionKey: string;
  action: "started" | "ended";
  durationMs?: number;
}

/**
 * Read a Live Voice boundary from existing ConversationMessage fields. The id keeps only a stable
 * hash of the session id; the end duration is an itemType suffix, so protocol adapters do
 * not need a new field.
 */
export function parseLiveVoiceSessionMarker(value: unknown): LiveVoiceSessionMarker | undefined {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.itemType) ||
    value.author !== "system" ||
    value.text !== ""
  )
    return undefined;
  const match = /^livevoice-([a-f0-9]{48})-(start|end)$/u.exec(value.id);
  if (!match) return undefined;
  const sessionKey = match[1];
  const phase = match[2];
  if (!sessionKey || !phase) return undefined;

  if (phase === "start") {
    return value.itemType === LIVE_VOICE_SESSION_START_ITEM_TYPE ? { sessionKey, action: "started" } : undefined;
  }

  const durationMatch = /^live-voice-session-end:(0|[1-9]\d*)$/u.exec(value.itemType);
  const durationMs = Number(durationMatch?.[1]);
  if (!durationMatch || !Number.isSafeInteger(durationMs)) return undefined;
  return { sessionKey, action: "ended", durationMs };
}
