import type { PlatformOSType } from "react-native";

export type ChatScreenAnimation = "none" | "slide_from_right";

export function chatScreenAnimation(platform: PlatformOSType): ChatScreenAnimation {
  return platform === "android" ? "none" : "slide_from_right";
}
