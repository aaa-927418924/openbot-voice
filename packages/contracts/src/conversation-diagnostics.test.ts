import { describe, expect, it } from "vitest";
import { conversationTextTag, parseConversationDiagnosticEvent } from "./conversation-diagnostics";

describe("parseConversationDiagnosticEvent", () => {
  it("keeps the flat fields of a known record and drops everything else", () => {
    const event = parseConversationDiagnosticEvent({
      kind: "delta",
      agent: "abc12345",
      revision: 7,
      applied: true,
      bodyAfter: 2398,
      text: "the message body must not cross the boundary",
      nested: { body: "x" },
    });

    expect(event).toEqual({ kind: "delta", agent: "abc12345", revision: 7, applied: true, bodyAfter: 2398 });
  });

  it("keeps the nullable latest-message fields", () => {
    expect(
      parseConversationDiagnosticEvent({
        kind: "page_applied",
        latestId: null,
        latestLength: null,
        previousRevision: null,
      }),
    ).toEqual({ kind: "page_applied", latestId: null, latestLength: null, previousRevision: null });
  });

  it("rejects an unknown kind", () => {
    expect(parseConversationDiagnosticEvent({ kind: "message", text: "hi" })).toBeNull();
  });
});

describe("conversationTextTag", () => {
  it("matches equal text and separates different text without returning it", () => {
    expect(conversationTextTag("hello")).toBe(conversationTextTag("hello"));
    expect(conversationTextTag("hello")).not.toBe(conversationTextTag("hellp"));
    expect(conversationTextTag("hello")).toMatch(/^[0-9a-f]{8}$/u);
  });
});
