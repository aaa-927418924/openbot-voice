import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/remoteDesktop";

export const messages = {
  "mobile.remoteDesktop.workspaceLabel": "Área de trabalho remota",
  "mobile.remoteDesktop.viewerTitle": "Área de trabalho remota",
  "mobile.remoteDesktop.connecting": "Conectando à área de trabalho…",
  "mobile.remoteDesktop.back": "Voltar ao OpenBot",
  "mobile.remoteDesktop.hostOffline": "Reconecte-se ao host antes de abrir a área de trabalho.",
  "mobile.remoteDesktop.notSharing":
    "Este host não oferece suporte à área de trabalho remota ou o compartilhamento de tela não está configurado.",
  "mobile.remoteDesktop.openFailed": "Não foi possível abrir a área de trabalho remota.",
} satisfies PartialTranslation<typeof source>;
