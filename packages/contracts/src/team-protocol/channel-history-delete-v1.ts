// Additive channel transcript mutations. The released channel-chats-v1 routes stay unchanged.

import { adminRoute, fields, identifier } from "./admin-wire";

export const CHANNEL_HISTORY_DELETE_CAPABILITY = "channel-history-delete-v1";
export const DELETE_CHANNEL_MESSAGE_ROUTE = "/v1/channels/history/delete-message";
export const CLEAR_CHANNEL_HISTORY_ROUTE = "/v1/channels/history/clear";

const empty = fields({});

export const CHANNEL_HISTORY_DELETE_CODECS = new Map([
  [
    DELETE_CHANNEL_MESSAGE_ROUTE,
    adminRoute(fields({ channelId: identifier, messageId: identifier, operationId: identifier }), empty),
  ],
  [CLEAR_CHANNEL_HISTORY_ROUTE, adminRoute(fields({ channelId: identifier, operationId: identifier }), empty)],
]);
