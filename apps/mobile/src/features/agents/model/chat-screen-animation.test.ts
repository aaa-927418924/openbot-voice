import { describe, expect, it } from "vitest";
import { chatScreenAnimation } from "./chat-screen-animation";

describe("chatScreenAnimation", () => {
  it("opens Android agent and channel chats without a page transition", () => {
    expect(chatScreenAnimation("android")).toBe("none");
  });

  it("keeps the existing transition on other platforms", () => {
    expect(chatScreenAnimation("ios")).toBe("slide_from_right");
  });
});
