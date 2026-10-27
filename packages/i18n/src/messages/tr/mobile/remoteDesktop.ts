import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/remoteDesktop";

export const messages = {
  "mobile.remoteDesktop.workspaceLabel": "Uzak masaüstü",
  "mobile.remoteDesktop.viewerTitle": "Uzak masaüstü",
  "mobile.remoteDesktop.connecting": "Masaüstüne bağlanıyor…",
  "mobile.remoteDesktop.back": "OpenBot'a dön",
  "mobile.remoteDesktop.hostOffline": "Masaüstünü açmadan önce ana bilgisayara yeniden bağlanın.",
  "mobile.remoteDesktop.notSharing":
    "Bu ana bilgisayar uzak masaüstünü desteklemiyor veya ekran paylaşımı ayarlanmamış.",
  "mobile.remoteDesktop.openFailed": "Uzak masaüstü açılamadı.",
} satisfies PartialTranslation<typeof source>;
