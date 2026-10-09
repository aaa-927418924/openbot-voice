import { describe, expect, it, vi } from "vitest";
import { openChatFromLink } from "./chat-link-navigation";
import { createChatNavigationGate } from "./chat-navigation-gate";

describe("openChatFromLink", () => {
  it("opens Android home-list chats even if an iOS transition gate is stale", () => {
    const gate = createChatNavigationGate();
    gate.start();
    const navigate = vi.fn();

    openChatFromLink({ gate, isAndroid: true, routeName: "connected", navigate, isFocused: () => true });

    expect(navigate).toHaveBeenCalledOnce();
  });

  it("keeps the transition gate for iOS home-list chats", () => {
    const gate = createChatNavigationGate();
    gate.start();
    const navigate = vi.fn();

    openChatFromLink({ gate, isAndroid: false, routeName: "connected", navigate, isFocused: () => true });

    expect(navigate).not.toHaveBeenCalled();
    gate.finish();
    expect(navigate).toHaveBeenCalledOnce();
  });
});
