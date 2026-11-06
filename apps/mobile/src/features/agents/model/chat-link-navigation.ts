import type { createChatNavigationGate } from "./chat-navigation-gate";

export function openChatFromLink({
  gate,
  isAndroid,
  routeName,
  navigate,
  isFocused,
}: {
  gate: ReturnType<typeof createChatNavigationGate> | null;
  isAndroid: boolean;
  routeName: string;
  navigate: () => void;
  isFocused: () => boolean;
}) {
  // The gate protects iOS native chat transitions. Android has no chat transition, and a stale
  // transition state can otherwise swallow taps on every home-list row.
  if (gate && routeName === "connected" && !isAndroid) gate.request(navigate, isFocused);
  else navigate();
}
