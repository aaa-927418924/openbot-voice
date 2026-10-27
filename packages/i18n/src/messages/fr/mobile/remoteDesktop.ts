import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/remoteDesktop";

export const messages = {
  "mobile.remoteDesktop.workspaceLabel": "Bureau à distance",
  "mobile.remoteDesktop.viewerTitle": "Bureau à distance",
  "mobile.remoteDesktop.connecting": "Connexion au bureau…",
  "mobile.remoteDesktop.back": "Retour à OpenBot",
  "mobile.remoteDesktop.hostOffline": "Reconnectez-vous à l’hôte avant d’ouvrir son bureau.",
  "mobile.remoteDesktop.notSharing":
    "Cet hôte ne prend pas en charge le bureau à distance ou le partage d’écran n’est pas configuré.",
  "mobile.remoteDesktop.openFailed": "Impossible d’ouvrir le bureau à distance.",
} satisfies PartialTranslation<typeof source>;
