// Frozen optional live-voice-v1 wire contract. Keep IPC types and limits out of this file.
//
// What it grants, recorded here because freezing it makes it permanent: a client of a server can
// start, stop and text a Codex Live voice session that runs on an agent of that host. The SDP offer
// and its answer cross as opaque strings of at most 256000 characters; the media itself never uses
// these routes - it travels straight between the client's window and the host's Codex process over
// WebRTC, so the two machines also have to be able to reach each other. The host allows one session
// at a time and refuses a second with its busy error, and the agent id is in the body, so this
// module also refuses an agent hidden from the caller. The host reports its own session's lifecycle
// to every client with the capability through the optional `live-voice` event below, which is what
// tells the client that started a session when the host ends it. Widening any of it needs a second
// capability string.
import { isDynamicRecord, isOneOf, isString } from "../runtime-values";
import { adminRoute, empty, fields, identifier, type OptionalRouteCodec, string } from "./admin-wire";

export const LIVE_VOICE_CAPABILITY = "live-voice-v1";

/** The IPC limit of the same name, written out: a wire bound is a literal this contract owns. */
const SDP_LIMIT = 256_000;
const MESSAGE_LIMIT = 300;

export const LIVE_VOICE_ROUTES = {
  start: "/v1/live-voice/start",
  stop: "/v1/live-voice/stop",
  sendText: "/v1/live-voice/send-text",
} as const;

const sdp = string(SDP_LIMIT);

export const LIVE_VOICE_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    LIVE_VOICE_ROUTES.start,
    adminRoute(
      fields({ agentId: identifier, threadId: identifier, clientSessionId: identifier, sdpOffer: sdp }),
      fields({ sessionId: identifier, sdpAnswer: sdp }),
    ),
  ],
  [
    LIVE_VOICE_ROUTES.stop,
    adminRoute(fields({ agentId: identifier, threadId: identifier, sessionId: identifier }), empty),
  ],
  [
    LIVE_VOICE_ROUTES.sendText,
    adminRoute(
      fields({ agentId: identifier, threadId: identifier, sessionId: identifier, text: string(128_000) }),
      empty,
    ),
  ],
]);

export type LiveVoiceWireStatus = "starting" | "started" | "closed" | "error";

/** One host session, as the host tells every client holding the capability. */
export interface LiveVoiceWireEvent {
  type: "live-voice";
  agentId: string;
  threadId: string;
  sessionId: string;
  status: LiveVoiceWireStatus;
  message?: string;
}

/** The live voice event in `value`, or null for any other event. A malformed event throws. */
export function liveVoiceEvent(value: unknown): LiveVoiceWireEvent | null {
  if (!isDynamicRecord(value) || value.type !== "live-voice") return null;
  const { agentId, threadId, sessionId, status, message } = value;
  if (
    !isString(agentId) ||
    !agentId.length ||
    agentId.length > 128 ||
    !isString(threadId) ||
    !threadId.length ||
    threadId.length > 128 ||
    !isString(sessionId) ||
    !sessionId.length ||
    sessionId.length > 128 ||
    !isOneOf(["starting", "started", "closed", "error"] as const, status)
  )
    throw new Error("Invalid live voice event.");
  if (message !== undefined && (!isString(message) || message.length > MESSAGE_LIMIT))
    throw new Error("Invalid live voice event.");
  return { type: "live-voice", agentId, threadId, sessionId, status, ...(message === undefined ? {} : { message }) };
}

/**
 * The host refused the session: another one runs, the account cannot carry one, or the runtime
 * cannot serve it. Its text is a sentence for the member, so a route rethrows it as a 409 rather
 * than letting the router's single catch turn it into a 500 that would replace the sentence.
 */
export class LiveVoiceRefusedError extends Error {}
