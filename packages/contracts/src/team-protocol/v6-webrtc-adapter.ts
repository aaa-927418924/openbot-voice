import { isAgentEvent } from "../ipc-agent-events";
import { isCodexLiveVoice } from "../ipc-live-voice";
import { isTeamRealtimeEvent } from "../ipc-team-host";
import { isDynamicRecord, isString } from "../runtime-values";
import { isBrowserDisplayRoute } from "./browser-navigation-v1";
import { isBrowserViewSessionRoute } from "./browser-view-v1";
import { decodeTeamProtocolV2Json, type TeamProtocolV2EventFrame, type TeamProtocolV2Json } from "./v2";
import {
  decodeTeamProtocolV3WebRtcHttpRequest,
  decodeTeamProtocolV3WebRtcHttpResponse,
  encodeTeamProtocolV3WebRtcHttpRequest,
  encodeTeamProtocolV3WebRtcHttpResponse,
} from "./v3-webrtc-adapter";
import {
  decodeTeamProtocolV6CurrentHttpRequest,
  decodeTeamProtocolV6CurrentHttpResponse,
  encodeTeamProtocolV6CurrentHttpRequest,
  encodeTeamProtocolV6CurrentHttpResponse,
} from "./v6-adapter";
import {
  decodeTeamProtocolV6BaseCurrentEvent,
  encodeTeamProtocolV6BaseCurrentEvent,
  type TeamProtocolV6BaseCurrentEventDecodeResult,
} from "./v6-base-adapter";

export function encodeTeamProtocolV6WebRtcHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean; agentCreateModel?: boolean; agentLiveVoiceSettings?: boolean } = {},
) {
  // A GET reaches the v3 frame, whose frozen no-body route list cannot learn a route added after it.
  // The display route carries no request body at all, so its frame is the empty object.
  if (isBrowserDisplayRoute(method, path) || isBrowserViewSessionRoute(method, path)) return {};
  if (method === "GET" || method === "DELETE" || isRoutineTestRequest(method, path) || isRemoteViewerRoute(path))
    return encodeTeamProtocolV3WebRtcHttpRequest(method, path, value, options);
  return decodeTeamProtocolV2Json(
    JSON.parse(encodeTeamProtocolV6CurrentHttpRequest(method, path, value ?? {}, options)),
  );
}
export function decodeTeamProtocolV6WebRtcHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean; agentCreateModel?: boolean; agentLiveVoiceSettings?: boolean } = {},
) {
  if (isBrowserDisplayRoute(method, path) || isBrowserViewSessionRoute(method, path)) return {};
  if (method === "GET" || method === "DELETE" || isRoutineTestRequest(method, path) || isRemoteViewerRoute(path))
    return decodeTeamProtocolV3WebRtcHttpRequest(method, path, value, options);
  return decodeTeamProtocolV2Json(decodeTeamProtocolV6CurrentHttpRequest(method, path, value ?? {}, options));
}
export function encodeTeamProtocolV6WebRtcHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
  options: {
    preserveSemanticTags?: boolean;
    preserveBrowserSecrets?: boolean;
    agentLiveVoiceSettings?: boolean;
  } = {},
) {
  if (status === 204) return {};
  if (isRemoteViewerRoute(path)) return encodeTeamProtocolV3WebRtcHttpResponse(method, path, status, value, options);
  return decodeTeamProtocolV2Json(
    JSON.parse(encodeTeamProtocolV6CurrentHttpResponse(method, path, status, value ?? null, options)),
  );
}
export function decodeTeamProtocolV6WebRtcHttpResponse(method: string, path: string, status: number, value: unknown) {
  if (status === 204) return {};
  if (isRemoteViewerRoute(path)) return decodeTeamProtocolV3WebRtcHttpResponse(method, path, status, value);
  return decodeTeamProtocolV2Json(decodeTeamProtocolV6CurrentHttpResponse(method, path, status, value ?? null));
}
export function createTeamProtocolV6Event(
  sequence: number,
  value: unknown,
  options: {
    preserveSemanticTags?: boolean;
    preserveBrowserSecrets?: boolean;
    agentLiveVoiceSettings?: boolean;
  } = {},
): Extract<TeamProtocolV2EventFrame, { type: "event" }> {
  const encoded = encodeTeamProtocolV6CurrentEvent(value, options);
  if (!encoded) throw new Error("Invalid Team protocol v6 event.");
  const payload = JSON.parse(encoded);
  return { version: 2, type: "event", sequence, payload: decodeTeamProtocolV2Json(payload) };
}

/** Encodes the current event payload used by HTTPS, with its capability-gated fields. */
export function encodeTeamProtocolV6CurrentEvent(
  value: unknown,
  options: {
    preserveSemanticTags?: boolean;
    preserveBrowserSecrets?: boolean;
    agentLiveVoiceSettings?: boolean;
  } = {},
): string | null {
  const baseValue = options.agentLiveVoiceSettings ? withoutCodexLiveVoices(value) : value;
  const decoded =
    isAgentEvent(baseValue) || isTeamRealtimeEvent(baseValue)
      ? { kind: "known" as const, event: baseValue }
      : decodeTeamProtocolV6BaseCurrentEvent(baseValue);
  if (decoded.kind !== "known") return null;
  const encoded = encodeTeamProtocolV6BaseCurrentEvent(decoded.event, options);
  if (!encoded || !options.agentLiveVoiceSettings) return encoded;
  const payload = JSON.parse(encoded);
  return JSON.stringify(attachCodexLiveVoices(payload, value));
}

/** Decodes a current event payload and restores the optional GPT Live voice field. */
export function decodeTeamProtocolV6CurrentEventPayload(value: unknown): TeamProtocolV6BaseCurrentEventDecodeResult {
  const decoded = decodeTeamProtocolV6BaseCurrentEvent(withoutCodexLiveVoices(value));
  if (
    decoded.kind !== "known" ||
    decoded.event.type !== "agents-changed" ||
    !isDynamicRecord(value) ||
    !Array.isArray(value.bots)
  ) {
    return decoded;
  }
  const bots = value.bots;
  if (bots.length !== decoded.event.agents.length) {
    return { kind: "invalid", type: isString(value.type) ? value.type : null };
  }
  const agents = decoded.event.agents.map((agent, index) => {
    const bot = bots[index];
    if (!isDynamicRecord(bot) || bot.codexLiveVoice === undefined) return agent;
    return isCodexLiveVoice(bot.codexLiveVoice) ? { ...agent, codexLiveVoice: bot.codexLiveVoice } : null;
  });
  const validAgents = agents.filter((agent): agent is (typeof decoded.event.agents)[number] => agent !== null);
  if (validAgents.length !== agents.length) {
    return { kind: "invalid", type: isString(value.type) ? value.type : null };
  }
  return { kind: "known", event: { ...decoded.event, agents: validAgents } };
}

export function decodeTeamProtocolV6CurrentEvent(frame: TeamProtocolV2EventFrame) {
  if (frame.type !== "event") return { status: "invalid" as const };
  const decoded = decodeTeamProtocolV6CurrentEventPayload(frame.payload);
  if (decoded.kind === "invalid" && !(isDynamicRecord(frame.payload) && isString(frame.payload.type)))
    return { status: "unknown" as const };
  return decoded.kind === "known" ? { status: "known" as const, event: decoded.event } : { status: decoded.kind };
}

function attachCodexLiveVoices(payload: TeamProtocolV2Json, source: unknown): TeamProtocolV2Json {
  if (!isV2JsonObject(payload)) return payload;
  const currentSource =
    isDynamicRecord(source) && source.type === "agents-changed" && Array.isArray(source.agents) ? source.agents : null;
  const wireSource =
    isDynamicRecord(source) && source.type === "bots-changed" && Array.isArray(source.bots) ? source.bots : null;
  if (
    payload.type !== "bots-changed" ||
    !Array.isArray(payload.bots) ||
    (!currentSource && !wireSource) ||
    payload.bots.length !== (currentSource ?? wireSource)?.length
  )
    return payload;
  const bots = payload.bots;
  const agents = currentSource ?? wireSource ?? [];
  return {
    ...payload,
    bots: bots.map((bot, index) => {
      const agent = agents[index];
      if (!isV2JsonObject(bot) || !isDynamicRecord(agent) || agent.codexLiveVoice === undefined) return bot;
      if (!isCodexLiveVoice(agent.codexLiveVoice)) throw new Error("Invalid Codex Live voice setting in agent event.");
      return { ...bot, codexLiveVoice: agent.codexLiveVoice };
    }),
  };
}

function withoutCodexLiveVoices(value: unknown): TeamProtocolV2Json {
  const json = decodeTeamProtocolV2Json(value);
  if (!isV2JsonObject(json) || !Array.isArray(json.agents ?? json.bots)) return json;
  const isCurrentEvent = json.type === "agents-changed";
  const isWireEvent = json.type === "bots-changed";
  if (!isCurrentEvent && !isWireEvent) return json;
  const key = isCurrentEvent ? "agents" : "bots";
  const entries = json[key];
  if (!Array.isArray(entries)) return json;
  return {
    ...json,
    [key]: entries.map((entry) => {
      if (!isV2JsonObject(entry) || entry.codexLiveVoice === undefined) return entry;
      const { codexLiveVoice: _codexLiveVoice, ...base } = entry;
      return base;
    }),
  };
}

function isV2JsonObject(value: TeamProtocolV2Json | undefined): value is { [key: string]: TeamProtocolV2Json } {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRoutineTestRequest(method: string, path: string): boolean {
  return (
    method === "POST" &&
    /^\/v1\/agents\/[^/]+\/routines\/[^/]+\/test$/u.test(new URL(path, "http://openbot.invalid").pathname)
  );
}

function isRemoteViewerRoute(path: string): boolean {
  return /^\/v1\/remote-screen\/sessions\/[A-Za-z0-9-]+\/(?:viewer|authorize|viewer-state|moonlight(?:\/.*)?)$/u.test(
    new URL(path, "http://openbot.invalid").pathname,
  );
}
