import { ContextResetBusyError } from "@openbot/contracts/team-protocol/context-reset-v1";
import {
  CLEAR_CONVERSATION_HISTORY_ROUTE,
  CONVERSATION_HISTORY_DELETE_CAPABILITY,
  DELETE_CONVERSATION_MESSAGE_ROUTE,
} from "@openbot/contracts/team-protocol/conversation-history-delete-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, stringField } from "./request-helpers";

export async function routeConversationHistoryDelete(
  context: TeamApiRequestContext,
  agents: Pick<TeamApiAgents, "deleteConversationMessage" | "clearConversationHistory" | "listAgents">,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  if (
    method !== "POST" ||
    ![DELETE_CONVERSATION_MESSAGE_ROUTE, CLEAR_CONVERSATION_HISTORY_ROUTE].includes(url.pathname)
  )
    return "unmatched";
  if (!capabilities.has(CONVERSATION_HISTORY_DELETE_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.conversationHistoryUnsupported"));
  const body = await readJson(request);
  const agentId = stringField(body, "agentId");
  if (hiddenAgentIds.has(agentId) || !agents.listAgents().some((agent) => agent.id === agentId))
    throw new HttpError(404, sourceText("error.team.agentNotFound"));
  try {
    if (url.pathname === DELETE_CONVERSATION_MESSAGE_ROUTE) {
      await runCauseEffect(agents.deleteConversationMessage({ agentId, messageId: stringField(body, "messageId") }));
    } else {
      await runCauseEffect(agents.clearConversationHistory(agentId));
    }
  } catch (error) {
    if (error instanceof ContextResetBusyError) throw new HttpError(409, error.message);
    throw error;
  }
  return json(200, {});
}
