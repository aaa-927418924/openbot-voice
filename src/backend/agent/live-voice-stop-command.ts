const STOP_COMMANDS = new Set(
  [
    "音声会話を停止して",
    "音声会話を停止してください",
    "音声会話を止めて",
    "音声会話を止めてください",
    "音声会話を終了して",
    "音声会話を終了してください",
    "音声会話終了",
    "通話を終了して",
    "通話を終了してください",
    "通話を終了",
    "通話を止めて",
    "通話を止めてください",
    "通話停止",
    "通話終了",
    "電話を切って",
    "電話を切ってください",
    "電話を終了して",
    "電話終了",
  ].map(normalizeSpokenCommand),
);

/** Matches a complete user utterance so a request that only mentions stopping is not cut short. */
export function isLiveVoiceStopCommand(text: string): boolean {
  return STOP_COMMANDS.has(normalizeSpokenCommand(text));
}

function normalizeSpokenCommand(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}
