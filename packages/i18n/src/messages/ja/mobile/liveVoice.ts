import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/liveVoice";

export const messages = {
  "mobile.liveVoice.start": "Live Voiceを開始",
  "mobile.liveVoice.stop": "通話を終了",
  "mobile.liveVoice.mute": "マイクをミュート",
  "mobile.liveVoice.unmute": "マイクのミュートを解除",
  "mobile.liveVoice.resumeAudio": "音声を再生",
  "mobile.liveVoice.microphoneActivity": "マイク音声レベル",
  "mobile.liveVoice.playbackActivity": "AI音声レベル",
  "mobile.liveVoice.elapsed": "通話時間 {time}",
  "mobile.liveVoice.status.connecting": "Live Voiceに接続中…",
  "mobile.liveVoice.status.live": "Live Voice通話中",
  "mobile.liveVoice.status.stopping": "Live Voiceを終了中…",
  "mobile.liveVoice.status.cleanupNeeded": "ホスト側で通話が続いている。もう一度終了して。",
  "mobile.liveVoice.status.ended": "Live Voice終了",
  "mobile.liveVoice.error.microphone": "マイクにアクセスできない。アプリの権限を確認して。",
  "mobile.liveVoice.error.unavailable": "Live Voiceに接続できない。接続を確認してもう一度試して。",
  "mobile.liveVoice.error.stop": "Live Voiceを終了できなかった。ホスト側で通話が続いている場合がある。",
  "mobile.liveVoice.error.send": "Live Voiceにテキストを送れなかった。入力は復元した。",
  "mobile.liveVoice.error.textOnly": "Live Voiceにはテキストだけ送れる。添付ファイルと返信を外して。",
  "mobile.liveVoice.history.started": "Live Voice を開始",
  "mobile.liveVoice.history.ended": "Live Voice を終了 · {time}",
} as const satisfies PartialTranslation<typeof source>;
