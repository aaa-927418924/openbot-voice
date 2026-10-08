import type { AgentMessage } from "@openbot/ui/data";
import { describe, expect, it, vi } from "vitest";
import { testConversationProps } from "../conversation-test-props";
import type { ComposerDraft, ConversationProps } from "../conversation-types";
import { createMessageActions, type MessageActionsDeps } from "./message-actions";

type MessageDeleted = NonNullable<ConversationProps["onMessageDeleted"]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function messageActions(
  onMessageDeleted: MessageDeleted,
  deleteConversationMessage: MessageActionsDeps["deleteConversationMessage"],
) {
  const props = testConversationProps("agent-a");
  props.deleteMessagesSupported = true;
  props.onMessageDeleted = onMessageDeleted;
  const deps: MessageActionsDeps = {
    props,
    deleteConversationMessage,
    installedSkills: () => [],
    currentDraft: () => ({ text: "", attachments: [], replyToMessageId: null }) satisfies ComposerDraft,
    updateCurrentDraft: vi.fn(),
    currentTarget: () => ({ agentId: "agent-a", serverId: "server-a" }),
    editingAgentId: () => null,
    editingServerId: () => null,
    editingDeliveryId: () => null,
    editingPendingSave: () => null,
    setOpenReactionMessageId: vi.fn(),
    setOpenMoreMessageId: vi.fn(),
    setExpandedEmojiMessageId: vi.fn(),
    copiedMessageId: () => null,
    setCopiedMessageId: vi.fn(),
    setComposerError: vi.fn(),
  };
  return createMessageActions(deps);
}

describe("message deletion", () => {
  it("sends one request for repeated clicks and removes the row after success", async () => {
    const request = deferred<void>();
    const deleteConversationMessage = vi.fn<MessageActionsDeps["deleteConversationMessage"]>(() => request.promise);
    const onMessageDeleted = vi.fn<MessageDeleted>();
    const actions = messageActions(onMessageDeleted, deleteConversationMessage);
    const message: AgentMessage = { id: "message-a", author: "you", body: "Hello", time: "now" };

    const first = actions.deleteMessage(message);
    const second = actions.deleteMessage(message);

    expect(deleteConversationMessage).toHaveBeenCalledTimes(1);
    request.resolve();
    await Promise.all([first, second]);
    expect(onMessageDeleted).toHaveBeenCalledTimes(1);
    expect(onMessageDeleted).toHaveBeenCalledWith("agent-a", "message-a", "local");
  });
});
