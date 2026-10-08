import type { ConversationMessage } from "@openbot/contracts/ipc";
import { CONVERSATION_PLAN_ITEM_TYPE } from "@openbot/contracts/ipc";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";
import { displayMessageReferences } from "./delivery-content";

/** Finds the latest message that appears as chat content in the sidebar preview. */
export function latestConversationPreview(
  messages: readonly ConversationMessage[],
  agentNames: ReadonlyMap<string, string>,
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !message ||
      message.author === "system" ||
      message.itemType === "commentary" ||
      message.itemType === "question_prompt" ||
      message.itemType === CONVERSATION_PLAN_ITEM_TYPE
    ) {
      continue;
    }
    const text = cleanAgentMessageText(
      displayMessageReferences(message.text, message.attachments ?? [], agentNames),
    ).trim();
    if (text) return text;
    const attachmentNames = (message.attachments ?? []).map((attachment) => attachment.name).join(", ");
    if (attachmentNames) return attachmentNames;
  }
  return "";
}
