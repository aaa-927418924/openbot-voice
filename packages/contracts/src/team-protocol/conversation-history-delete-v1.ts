// Additive, capability-gated conversation history mutations. Released agent routes keep their meaning.

import { adminRoute, fields, identifier } from "./admin-wire";

export const CONVERSATION_HISTORY_DELETE_CAPABILITY = "conversation-history-delete-v1";
export const DELETE_CONVERSATION_MESSAGE_ROUTE = "/v1/conversation-history/delete-message";
export const CLEAR_CONVERSATION_HISTORY_ROUTE = "/v1/conversation-history/clear-agent";

const empty = fields({});

export const CONVERSATION_HISTORY_DELETE_CODECS = new Map([
  [DELETE_CONVERSATION_MESSAGE_ROUTE, adminRoute(fields({ agentId: identifier, messageId: identifier }), empty)],
  [CLEAR_CONVERSATION_HISTORY_ROUTE, adminRoute(fields({ agentId: identifier }), empty)],
]);
