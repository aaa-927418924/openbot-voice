import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/computerUse";

export const messages = {
  "error.computerUse.noAppToDrag": "この OpenBot ビルドにはドラッグするアプリケーションがありません。",
  "error.computerUse.helpWindowChanged": "ドラッグを開始する前に、権限のヘルプウィンドウが変わりました。",
  "error.computerUse.noAppToShow": "この OpenBot ビルドには表示するアプリケーションがありません。",
  "error.computerUse.noDriver": "このコンピューターには Computer Use ドライバーがありません。",
  "error.computerUse.socketPathTooLong":
    "Computer Use のソケットパスは {length} 文字ですが、このシステムでは {limit} 文字までです。",
  "error.computerUse.socketDirectoryNotDirectory":
    "Computer Use のソケットディレクトリ {path} はディレクトリではありません。",
  "error.computerUse.socketDirectoryOtherOwner":
    "Computer Use のソケットディレクトリ {path} は別のユーザーが所有しています。",
  "error.computerUse.socketDirectoryShared":
    "Computer Use のソケットディレクトリ {path} は他のユーザーに公開されています。",
  "error.computerUse.socketNotReady": "{seconds} 秒以内に接続を受け付けませんでした。{reason}",
  "error.computerUse.remoteDevicePermission": "このエージェントには対象デバイスでの操作権限がありません。",
  "error.computerUse.remoteCommandBlocked":
    "AutoReview が危険度の高いリモートコマンドをブロックしました。再試行したり、別のコマンドで回避したりしないでください。",
  "error.computerUse.remoteCommandInvalid": "リモートコマンドの内容が無効です。",
  "error.computerUse.remoteAutoReviewUnavailable":
    "対象PCのOpenBotでCodex CLIにサインインしていないか、AutoReviewを利用できないため、コマンドを拒否しました。",
  "error.computerUse.remoteOperationUnavailable": "リモートデバイス操作を利用できません。",
} as const satisfies PartialTranslation<typeof source>;
