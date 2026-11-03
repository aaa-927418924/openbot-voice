import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  "window.localHostTitle": "Computador anfitrião local do OpenBot",
  "window.localClientTitle": "Cliente local do OpenBot",
  "window.computerUsePermissionTitle": "Ativar Uso do computador",
  "window.controls.minimize": "Minimizar janela",
  "window.controls.maximizeRestore": "Maximizar ou restaurar janela",
  "window.controls.close": "Fechar janela",
} as const satisfies PartialTranslation<typeof source>;
