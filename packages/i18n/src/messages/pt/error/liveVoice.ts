import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/liveVoice";

export const messages = {
  "error.liveVoice.unavailable": "A voz ao vivo não está disponível para esta conversa ou ambiente de execução.",
  "error.liveVoice.accountRequired": "Entre no Codex para usar a voz ao vivo.",
  "error.liveVoice.busy": "Esta conversa do Codex já está usando voz ao vivo.",
} as const satisfies PartialTranslation<typeof source>;
