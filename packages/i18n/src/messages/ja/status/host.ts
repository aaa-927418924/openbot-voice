import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/host";

export const messages = {
  // Status lines of the WebRTC host.
  "status.host.registered": "この OpenBot を WebRTC アクセス用に登録しました。",
  "status.host.identityUpdated": "サーバーの ID を更新しました。",
  "status.host.starting": "WebRTC ホストを起動しています…",
  "status.host.ready": "この OpenBot は WebRTC 接続の準備ができています。",
  "status.host.stopping": "この OpenBot を非公開にしています…",
  "status.host.private": "この OpenBot は非公開です。",
  "status.host.migrationMissingAttachments": {
    one: "添付ファイル 1 件は移行元ですでに見つからなかったため、チャット内の参照だけを保持しました。ファイル本体は移行できていません。",
    other:
      "添付ファイル {count} 件は移行元ですでに見つからなかったため、チャット内の参照だけを保持しました。ファイル本体は移行できていません。",
  },
} as const satisfies PartialTranslation<typeof source>;
