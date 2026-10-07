import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/liveVoice";

export const messages = {
  "error.liveVoice.unavailable": "Bu görüşme veya çalışma zamanı için canlı ses kullanılamıyor.",
  "error.liveVoice.accountRequired": "Canlı sesi kullanmak için Codex'te oturum açın.",
  "error.liveVoice.busy": "Bu Codex görüşmesinde canlı ses zaten kullanılıyor.",
} as const satisfies PartialTranslation<typeof source>;
