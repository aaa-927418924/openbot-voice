import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/remoteDesktop";

export const messages = {
  "mobile.remoteDesktop.workspaceLabel": "リモートデスクトップ",
  "mobile.remoteDesktop.viewerTitle": "リモートデスクトップ",
  "mobile.remoteDesktop.connecting": "デスクトップに接続しています…",
  "mobile.remoteDesktop.back": "OpenBot に戻る",
  "mobile.remoteDesktop.hostOffline": "ホストに再接続してからデスクトップを開いてください。",
  "mobile.remoteDesktop.notSharing":
    "このホストはリモートデスクトップに対応していないか、画面共有が設定されていません。",
  "mobile.remoteDesktop.openFailed": "リモートデスクトップを開けませんでした。",
} satisfies PartialTranslation<typeof source>;
