import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/computerUse";

export const messages = {
  // Computer Use settings, the permission help window, and the window highlight.
  "computerUse.permission.screenRecording.title": "画面収録",
  "computerUse.permission.screenRecording.description": "OpenBot がアプリのウインドウを見られるようにします。",
  "computerUse.permission.screenRecording.pane": "画面収録とシステムオーディオ録音",
  "computerUse.permission.accessibility.title": "アクセシビリティ",
  "computerUse.permission.accessibility.description": "OpenBot がクリックや入力をできるようにします。",
  "computerUse.permission.accessibility.pane": "アクセシビリティ",
  "computerUse.error.check": "OpenBot は Computer Use を確認できませんでした。",
  "computerUse.error.openSettings": "OpenBot はシステム設定を開けませんでした。",
  "computerUse.error.startDriver": "OpenBot は Computer Use ドライバを起動できませんでした。",
  "computerUse.checkAgain": "もう一度確認",
  "computerUse.checking": "Computer Use を確認しています",
  "computerUse.unavailable.title": "Computer Use はまだ利用できません",
  "computerUse.permissions.title": "システムの権限",
  "computerUse.permissions.description": "権限は macOS が管理します。",
  "computerUse.ready.title": "Computer Use の準備ができました",
  "computerUse.ready.description":
    "OpenBot はこのコンピュータのアプリを見て操作できます。このシステムでは追加の権限は必要ありません。",
  "computerUse.openSettingsFailed.title": "システム設定を開けませんでした",
  "computerUse.compact.title": "Computer Use を有効にする",
  "computerUse.compact.description": "OpenBot がこのコンピュータのアプリを見て操作できるようにします。",
  "computerUse.granted": "許可済み",
  "computerUse.opening": "開いています…",
  "computerUse.manage": "管理",
  "computerUse.grant": "許可",
  "computerUse.manageLabel": "{permission}を管理",
  "computerUse.grantLabel": "{permission}を許可",
  "computerUse.help.title": "{permission}をオンにする",
  "computerUse.help.paneOpen": "システム設定で「{pane}」が開いています。",
  "computerUse.help.dragLabel": "{name} をシステム設定にドラッグするか、押して Finder に表示します",
  "computerUse.help.dragToAdd": "ドラッグして追加",
  "computerUse.help.findInList": "リストで {name} を探してください。",
  "computerUse.help.dragIntoList": "{name}.app をリストにドラッグしてください。",
  "computerUse.help.turnOn": "スイッチをオンにしてください。",
  "computerUse.help.showInFinder": "Finder に表示",
  "computerUse.help.revealFailed": "アプリケーションを Finder に表示できませんでした。",
  "computerUse.help.dragFailed": "アプリケーションをドラッグできませんでした。",
  "computerUse.highlight.working": "OpenBot が {title} で作業しています",
  "computerUse.remote.title": "このPCの操作権限",
  "computerUse.remote.description":
    "このPCの権限だけを設定します。すべてのエージェントからの操作に適用されます。コマンドはこのPCのOpenBotにサインインしたCodex CLIでAutoReviewし、利用できない場合は拒否します。",
  "computerUse.remote.refresh": "状態を更新",
  "computerUse.remote.empty.local":
    "このPCの操作情報がまだありません。リモートデバイス共有を有効にすると、このPCが操作対象として準備されます。",
  "computerUse.remote.share.title": "このPCをリモートデバイス操作に共有",
  "computerUse.remote.share.description":
    "通常のOpenBotサーバーとして有効にせず、このアカウントの他デバイスから操作できるようにします。",
  "computerUse.remote.error.share":
    "このPCを共有できませんでした。アカウントのサインインと接続状態を確認してください。",
  "computerUse.remote.autoReviewUnavailable":
    "このPCのOpenBotでCodex CLIにサインインしてください。AutoReviewが使えるようになるまでコマンドは拒否されます。",
  "computerUse.remote.signInCodex": "Codex CLIにサインイン",
  "computerUse.remote.signingInCodex": "Codex CLIのサインインを開始しています…",
  "computerUse.remote.signInError": "Codex CLIのサインインを開始できませんでした。",
  "computerUse.remote.signInExpired": "Codex CLIのサインインコードの期限が切れました。もう一度開始してください。",
  "computerUse.remote.signInUnsupported": "Codex CLIのサインインを開始できませんでした。",
  "computerUse.remote.autoReviewReady": "このPCでCodex CLIのサインインが完了し、AutoReviewを利用できます。",
  "computerUse.remote.computerUseUnavailable": "このPCでは Computer Use を利用できません。",
  "computerUse.remote.loading": "このPCの権限を読み込んでいます…",
  "computerUse.remote.commands.title": "コマンド実行を許可",
  "computerUse.remote.commands.description":
    "このPCで全エージェントのコマンド実行を許可します。このPCのOpenBotでサインインしたCodex CLIが実行し、権限要求はAutoReviewで審査します。利用できない場合は拒否します。",
  "computerUse.remote.computerUse.title": "Computer Use を許可",
  "computerUse.remote.computerUse.description":
    "このPCで全エージェントの画面操作ツールを許可します。コマンド実行とは別の設定です。",
  "computerUse.remote.saved": "このPCに権限を保存しました。",
  "computerUse.remote.error.load": "このPCの操作情報を読み込めませんでした。",
  "computerUse.remote.error.permission": "このPCの権限を読み込めませんでした。",
  "computerUse.remote.error.save": "このPCに権限を保存できませんでした。",
} as const satisfies PartialTranslation<typeof source>;
