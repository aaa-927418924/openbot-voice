import { LIVE_VOICE_SDP_LIMIT, type LiveVoiceSendTextInput, type LiveVoiceStartInput } from "@openbot/contracts/ipc";
import {
  LIVE_VOICE_CHANNEL_START_ROUTE,
  LIVE_VOICE_CHANNEL_TRANSCRIPTS_CAPABILITY,
} from "@openbot/contracts/team-protocol/live-voice-channel-v1";
import {
  LIVE_VOICE_CAPABILITY,
  LIVE_VOICE_ROUTES,
  LiveVoiceRefusedError,
} from "@openbot/contracts/team-protocol/live-voice-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, stringField } from "./request-helpers";

/** The IPC limit of the same name; the wire codec has already checked the body against it. */
const TEXT_LIMIT = 128_000;

/**
 * Starting, stopping and texting a Live voice session that runs on an agent of this host. Any member
 * can do what the owner can, as any member can send the agent a message. The session control crosses
 * here and the media does not: the SDP offer goes to the service as an opaque string, the answer goes
 * back, and the audio flows between the two machines over WebRTC. The agent id is in the body, so the
 * router's check of the path does not see it, and this module refuses an agent hidden from the caller.
 *
 * A refusal - another session running, no ChatGPT account, a runtime that cannot carry one - is the
 * host's state rather than a fault, and its text is the sentence the member reads. It is rethrown as
 * a 409 so the router's single catch does not turn it into a 500 with a generic message. Frozen by
 * `live-voice-v1`.
 */
export async function routeLiveVoice(
  context: TeamApiRequestContext,
  agents: Pick<TeamApiAgents, "startLiveVoice" | "stopLiveVoice" | "sendLiveVoiceText">,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  if (method !== "POST") return "unmatched";
  const route =
    url.pathname === LIVE_VOICE_CHANNEL_START_ROUTE
      ? "channel-start"
      : url.pathname === LIVE_VOICE_ROUTES.start
        ? "start"
        : url.pathname === LIVE_VOICE_ROUTES.stop
          ? "stop"
          : url.pathname === LIVE_VOICE_ROUTES.sendText
            ? "sendText"
            : null;
  if (route === null) return "unmatched";
  if (!capabilities.has(LIVE_VOICE_CAPABILITY)) throw new HttpError(400, sourceText("error.team.liveVoiceUnsupported"));
  if (route === "channel-start" && !capabilities.has(LIVE_VOICE_CHANNEL_TRANSCRIPTS_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.liveVoiceUnsupported"));
  // `readJson` has already run the body through the live-voice wire codec.
  const body = await readJson(request);
  const agentId = stringField(body, "agentId");
  if (hiddenAgentIds.has(agentId)) throw new HttpError(404, sourceText("error.team.agentNotFound"));
  const threadId = stringField(body, "threadId");
  try {
    if (route === "start" || route === "channel-start") {
      const input: LiveVoiceStartInput = {
        agentId,
        threadId,
        clientSessionId: stringField(body, "clientSessionId"),
        sdpOffer: stringField(body, "sdpOffer", false, LIVE_VOICE_SDP_LIMIT),
        ...(route === "channel-start" ? { channelId: stringField(body, "channelId") } : {}),
      };
      const started =
        route === "channel-start"
          ? agents.startLiveVoice(input, { id: context.member.id, name: context.member.name ?? "" })
          : agents.startLiveVoice(input);
      return json(200, await runCauseEffect(started));
    }
    const sessionId = stringField(body, "sessionId");
    if (route === "stop") {
      await runCauseEffect(agents.stopLiveVoice({ agentId, threadId, sessionId }));
      return json(200, {});
    }
    const input: LiveVoiceSendTextInput = {
      agentId,
      threadId,
      sessionId,
      text: stringField(body, "text", false, TEXT_LIMIT),
    };
    await runCauseEffect(agents.sendLiveVoiceText(input));
    return json(200, {});
  } catch (error) {
    if (error instanceof LiveVoiceRefusedError) throw new HttpError(409, error.message);
    throw error;
  }
}
