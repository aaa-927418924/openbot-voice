import type { PlatformOSType } from "react-native";

export type ChatScreenAnimation = "none" | "slide_from_right";

/** Keep agent and channel chat routes on the same platform transition. */
export function chatScreenAnimation(platform: PlatformOSType): ChatScreenAnimation {
  return platform === "android" ? "none" : "slide_from_right";
}
