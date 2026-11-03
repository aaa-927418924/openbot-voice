import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/window";

export const messages = {
  "window.localHostTitle": "OpenBot Yerel Ana Makine",
  "window.localClientTitle": "OpenBot Yerel İstemci",
  "window.computerUsePermissionTitle": "Bilgisayar Kullanımını Aç",
  "window.controls.minimize": "Pencereyi küçült",
  "window.controls.maximizeRestore": "Pencereyi büyüt veya geri yükle",
  "window.controls.close": "Pencereyi kapat",
} as const satisfies PartialTranslation<typeof source>;
