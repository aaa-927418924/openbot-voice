const CALL_TARGETS = ["音声会話", "ライブ音声", "livevoice", "voicecall", "通話", "電話", "会話"];
const STOP_ACTIONS = ["停止", "終了", "終わ", "終えて", "止め", "止ま", "切っ", "切る", "切断", "やめ", "ストップ"];
const REQUEST_MARKERS = [
  "して",
  "ください",
  "してほしい",
  "してくれ",
  "してもら",
  "しよう",
  "終わって",
  "終わらせて",
  "終わりにして",
  "止めて",
  "切って",
  "やめて",
  "お願い",
  "したい",
];
const DIRECT_COMMANDS = new Set(
  [
    "音声会話終了",
    "音声会話を終了",
    "音声会話を停止",
    "ライブ音声を終了",
    "通話終了",
    "通話を終了",
    "通話停止",
    "通話を停止",
    "電話終了",
    "電話を終了",
  ].map(normalizeSpokenCommand),
);
const NON_COMMAND_CONTEXT = [
  "しないで",
  "しません",
  "したくない",
  "終わらせない",
  "という言葉",
  "って何",
  "の意味",
  "について説明",
  "説明して",
  "例文",
  "の例",
  "と言って",
  "って言って",
];

/**
 * Conservative fallback for threads that predate the model-side end-call tool. GPT Live is told to
 * decide intent semantically; this catches common Japanese ASR variants while requiring both a
 * call reference and a stop action.
 */
export function isLiveVoiceStopCommand(text: string): boolean {
  const normalized = normalizeSpokenCommand(text);
  if (!normalized || normalized.length > 160 || NON_COMMAND_CONTEXT.some((part) => normalized.includes(part)))
    return false;

  const referencesCall = CALL_TARGETS.some((term) => containsNear(normalized, term));
  const requestsStop = STOP_ACTIONS.some((term) => normalized.includes(term) || containsNear(normalized, term));
  const isDirectCommand = [...DIRECT_COMMANDS].some((command) => editDistanceAtMostOne(normalized, command));
  const soundsLikeARequest = REQUEST_MARKERS.some((marker) => normalized.includes(marker));
  return referencesCall && requestsStop && (isDirectCommand || soundsLikeARequest);
}

function normalizeSpokenCommand(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Finds a term with at most one character inserted, deleted, or substituted by speech recognition. */
function containsNear(text: string, term: string): boolean {
  if (text.includes(term)) return true;
  // Avoid treating common two-character words such as 会社 as a mistyped 通話/会話.
  if (term.length < 3) return false;
  const minLength = Math.max(1, term.length - 1);
  const maxLength = term.length + 1;
  for (let length = minLength; length <= maxLength; length += 1) {
    for (let start = 0; start + length <= text.length; start += 1) {
      if (editDistanceAtMostOne(text.slice(start, start + length), term)) return true;
    }
  }
  return false;
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}
