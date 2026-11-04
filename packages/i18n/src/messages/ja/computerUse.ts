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
  "computerUse.remote.title": "他のデバイス",
  "computerUse.remote.description":
    "Windows / Linux PCを選びます。権限はすべてのエージェントとサーバーに適用されます。コマンドは対象PCのOpenBotでサインインしたCodex CLIから実行し、権限要求をAutoReviewで審査します。利用できない場合は拒否されます。",
  "computerUse.remote.refresh": "デバイスを更新",
  "computerUse.remote.device": "操作対象デバイス",
  "computerUse.remote.empty.targets":
    "操作対象デバイスがありません。操作したいWindows / Linux PCでリモートデバイス共有を有効にしてください。",
  "computerUse.remote.thisComputer": "このPC（{name}）",
  "computerUse.remote.share.title": "このPCをリモートデバイス操作に共有",
  "computerUse.remote.share.description":
    "通常のOpenBotサーバーとして有効にせず、このアカウントの他デバイスから操作できるようにします。",
  "computerUse.remote.error.share":
    "このPCを共有できませんでした。アカウントのサインインと接続状態を確認してください。",
  "computerUse.remote.deviceOffline": "権限を編集するには、対象デバイスを接続してください。",
  "computerUse.remote.autoReviewUnavailable":
    "このPCのOpenBotでCodex CLIにサインインしてください。AutoReviewが使えるようになるまでコマンドは拒否されます。",
  "computerUse.remote.computerUseUnavailable": "対象デバイスで Computer Use を利用できません。",
  "computerUse.remote.loading": "デバイスの権限を読み込んでいます…",
  "computerUse.remote.commands.title": "コマンド実行を許可",
  "computerUse.remote.commands.description":
    "このデバイスで全エージェントのコマンド実行を許可します。対象PCのOpenBotでサインインしたCodex CLIが実行し、権限要求はAutoReviewで審査します。利用できない場合はコマンドを拒否します。",
  "computerUse.remote.computerUse.title": "Computer Use を許可",
  "computerUse.remote.computerUse.description":
    "このデバイスで全エージェントの画面操作ツールを許可します。コマンド実行とは別の設定です。",
  "computerUse.remote.saved": "対象デバイスに権限を保存しました。",
  "computerUse.remote.error.load": "リモートデバイスを読み込めませんでした。",
  "computerUse.remote.error.permission": "対象デバイスの権限を読み込めませんでした。",
  "computerUse.remote.error.save": "対象デバイスに権限を保存できませんでした。",
} as const satisfies PartialTranslation<typeof source>;
