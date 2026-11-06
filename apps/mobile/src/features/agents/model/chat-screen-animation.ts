import type { PlatformOSType } from "react-native";

export type ChatScreenAnimation = "none" | "slide_from_right";

/** Keep channel chats and the closing side of agent chats on the existing platform transition. */
export function chatScreenAnimation(platform: PlatformOSType): ChatScreenAnimation {
  return platform === "android" ? "none" : "slide_from_right";
}
