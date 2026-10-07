import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

/** The only renderer boundary that reaches the desktop Live voice IPC group. */
export type LiveVoicePort = OpenBotDesktopApi["liveVoice"];

export function liveVoicePort(): LiveVoicePort | undefined {
  return typeof window === "undefined" ? undefined : window.openbot?.liveVoice;
}
