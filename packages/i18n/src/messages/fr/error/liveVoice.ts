import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/liveVoice";

export const messages = {
  "error.liveVoice.unavailable":
    "La voix en direct n'est pas disponible pour cette conversation ou cet environnement d'exécution.",
  "error.liveVoice.accountRequired": "Connectez-vous à Codex pour utiliser la voix en direct.",
  "error.liveVoice.busy": "Cette conversation Codex utilise déjà la voix en direct.",
} as const satisfies PartialTranslation<typeof source>;
