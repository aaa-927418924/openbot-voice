const COMPLETE_INTERNAL_CITATION = /\u{e200}cite(?:\u{e202}[^\u{e201}]*)?\u{e201}/gu;
const STREAMING_INTERNAL_CITATION = /\u{e200}(?:c(?:i(?:t(?:e(?:\u{e202}[^\u{e201}]*)?)?)?)?)?$/u;
const INTERNAL_REALTIME_DELEGATION = /^\s*<realtime_delegation>\s*[\s\S]*?<\/realtime_delegation>\s*$/u;

/** Provider handoff bookkeeping is stored with older transcripts but is not conversation text. */
export function isInternalRealtimeDelegationMessage(text: string): boolean {
  return INTERNAL_REALTIME_DELEGATION.test(text);
}

export function cleanAgentMessageText(text: string): string {
  if (isInternalRealtimeDelegationMessage(text)) return "";
  return text.replace(COMPLETE_INTERNAL_CITATION, "").replace(STREAMING_INTERNAL_CITATION, "");
}
