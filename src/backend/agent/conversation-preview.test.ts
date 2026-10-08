import type { ConversationMessage } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { latestConversationPreview } from "./conversation-preview";

const userMessage = (id: string, text: string): ConversationMessage => ({
  id,
  author: "user",
  text,
  createdAt: "2026-10-09T00:00:00.000Z",
  status: "completed",
});

describe("latestConversationPreview", () => {
  it("uses the last visible message and skips hidden system and thinking rows", () => {
    const messages: ConversationMessage[] = [
      userMessage("earlier", "Keep this text."),
      { ...userMessage("thinking", "Thinking text."), author: "assistant", itemType: "commentary" },
      { ...userMessage("boundary", "Call ended."), author: "system" },
    ];

    expect(latestConversationPreview(messages, new Map())).toBe("Keep this text.");
  });

  it("returns attachment names when the latest user message has no text", () => {
    const message = {
      ...userMessage("attachment", ""),
      attachments: [
        {
          id: "file-a",
          name: "notes.txt",
          size: 12,
          kind: "file" as const,
          mimeType: "text/plain",
          previewKind: "text" as const,
          previewUrl: null,
        },
      ],
    };

    expect(latestConversationPreview([message], new Map())).toBe("notes.txt");
  });
});
