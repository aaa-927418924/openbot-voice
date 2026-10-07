import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/liveVoice";

export const messages = {
  "error.liveVoice.unavailable": "この会話またはランタイムではLive音声を利用できません。",
  "error.liveVoice.accountRequired": "Live音声を使うにはCodexにサインインしてください。",
  "error.liveVoice.busy": "このCodex会話ではすでにLive音声を使用中です。",
} as const satisfies PartialTranslation<typeof source>;
