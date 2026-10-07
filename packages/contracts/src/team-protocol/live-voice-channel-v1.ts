// Additive channel transcript destination for Live voice. The original live-voice-v1 route stays
// frozen; only hosts that advertise this capability accept channel-start.

import { adminRoute, fields, identifier, string } from "./admin-wire";

export const LIVE_VOICE_CHANNEL_TRANSCRIPTS_CAPABILITY = "live-voice-channel-transcripts-v1";
export const LIVE_VOICE_CHANNEL_START_ROUTE = "/v1/live-voice/channel-start";

const SDP_LIMIT = 256_000;
const sdp = string(SDP_LIMIT);

export const LIVE_VOICE_CHANNEL_CODECS = new Map([
  [
    LIVE_VOICE_CHANNEL_START_ROUTE,
    adminRoute(
      fields({
        agentId: identifier,
        threadId: identifier,
        clientSessionId: identifier,
        sdpOffer: sdp,
        channelId: identifier,
      }),
      fields({ sessionId: identifier, sdpAnswer: sdp }),
    ),
  ],
]);
