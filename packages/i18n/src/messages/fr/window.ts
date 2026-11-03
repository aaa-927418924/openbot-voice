import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  // Native window titles.
  "window.localHostTitle": "OpenBot – Hôte local",
  "window.localClientTitle": "OpenBot – Client local",
  "window.computerUsePermissionTitle": "Activer Computer Use",
  "window.controls.minimize": "Réduire la fenêtre",
  "window.controls.maximizeRestore": "Agrandir ou restaurer la fenêtre",
  "window.controls.close": "Fermer la fenêtre",
} as const satisfies PartialTranslation<typeof source>;
