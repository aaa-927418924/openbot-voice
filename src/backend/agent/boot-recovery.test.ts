import { describe, expect, it } from "vitest";
import { filterHiddenProviderHistoryMessages } from "./boot-recovery";

describe("filterHiddenProviderHistoryMessages", () => {
  it("filters deleted provider items and user prompts by their OpenBot client id", () => {
    const filtered = filterHiddenProviderHistoryMessages(
      {
        id: "provider-session",
        turns: [
          {
            id: "turn-1",
            items: [
              { id: "deleted-reply", type: "agentMessage", text: "Deleted reply" },
              {
                id: "provider-user-item",
                clientId: "deleted-delivery",
                type: "userMessage",
                content: [{ type: "text", text: "Deleted prompt" }],
              },
              { id: "kept-reply", type: "agentMessage", text: "Keep this reply" },
            ],
          },
        ],
      },
      (messageId) => messageId === "deleted-reply" || messageId === "deleted-delivery",
    );

    expect(filtered.turns?.[0]?.items).toEqual([{ id: "kept-reply", type: "agentMessage", text: "Keep this reply" }]);
  });

  it("keeps a deleted Live Voice typed row hidden by its canonical client id", () => {
    const canonicalId = "livevoice-0123456789abcdef0123456789abcdef0123456789abcdef";
    const filtered = filterHiddenProviderHistoryMessages(
      {
        id: "provider-session",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                id: "native-generated-user-id",
                clientId: canonicalId,
                type: "userMessage",
                content: [{ type: "text", text: "A deleted typed message" }],
              },
              {
                id: "kept-user-id",
                clientId: "ordinary-client-id",
                type: "userMessage",
                content: [{ type: "text", text: "A message that remains" }],
              },
            ],
          },
        ],
      },
      (messageId) => messageId === canonicalId,
    );

    expect(filtered.turns?.[0]?.items).toEqual([
      {
        id: "kept-user-id",
        clientId: "ordinary-client-id",
        type: "userMessage",
        content: [{ type: "text", text: "A message that remains" }],
      },
    ]);
  });
});
