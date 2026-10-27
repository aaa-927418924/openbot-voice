import { render, screen } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { expect, it, vi } from "vitest";
import type { AgentMessage } from "../../data";

vi.mock("@openbot/ui", () => {
  const Box = (props: { children?: JSX.Element; class?: string }) => <div class={props.class}>{props.children}</div>;
  return {
    Bubble: Box,
    BubbleContent: Box,
    Button: Box,
    Message: Box,
    MessageAvatar: Box,
    MessageContent: Box,
    MessageFooter: Box,
    MessageHeader: Box,
  };
});
vi.mock("../../text", () => ({ useText: () => ({ t: (key: string) => key }) }));
vi.mock("../agents/AgentAvatar", () => ({ AgentAvatar: () => <div /> }));
vi.mock("./MessageRendering", () => ({
  conversationBubbleVariant: () => "muted",
  MessageBody: () => <div>Message body</div>,
}));

import { ChatMessageRow } from "./ChatMessageRow";

it("hides user-side sender names while keeping the message time", () => {
  const message: AgentMessage = {
    id: "message-1",
    author: "you",
    body: "Hello",
    time: "12:30",
    createdAt: "2026-10-28T03:30:00.000Z",
  };

  render(() => (
    <ChatMessageRow
      message={message}
      author={{ kind: "member", name: "Alice Example" }}
      showAuthor
      showTime
      agents={[]}
      onSelectAgent={vi.fn()}
      onOpenLink={vi.fn()}
      onPreview={vi.fn()}
      onAttachmentAction={vi.fn()}
    />
  ));

  expect(screen.queryByText("Alice Example")).toBeNull();
  expect(screen.getByText("12:30")).toBeTruthy();
});
