import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  // Native window titles.
  "window.localHostTitle": "OpenBot ローカルホスト",
  "window.localClientTitle": "OpenBot ローカルクライアント",
  "window.computerUsePermissionTitle": "Computer Use をオンにする",
  "window.tray.open": "OpenBotを開く",
  "window.tray.quit": "OpenBotを終了",
} as const satisfies PartialTranslation<typeof source>;
