import type { PlatformOSType } from "react-native";

export type ChatScreenAnimation = "none" | "slide_from_right";

/** Keep the existing close transition for agent and channel chats. */
export function chatScreenAnimation(platform: PlatformOSType): ChatScreenAnimation {
  return platform === "android" ? "none" : "slide_from_right";
}
