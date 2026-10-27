export interface ChatLayout {
  viewport: number;
  content: number;
  header: number;
  tailY: number;
  tailHeight: number;
}

/** Minimum native inset, including the space occupied by the composer/keyboard. */
export function chatBlankSpace(layout: ChatLayout): number {
  "worklet";
  return Math.max(0, layout.viewport - layout.header - layout.tailHeight);
}

export function chatEndOffset(layout: ChatLayout, inset: number): number {
  "worklet";
  return Math.max(0, layout.content + inset - layout.viewport);
}

export function chatSendOffset(layout: ChatLayout, inset: number): number {
  "worklet";
  return Math.min(Math.max(0, layout.tailY - layout.header), chatEndOffset(layout, inset));
}

export function chatContentIsVisible(layout: ChatLayout, scrollY: number, obstruction: number): boolean {
  "worklet";
  // Blank space is not unread content. Only the keyboard and composer obscure messages.
  return layout.content <= scrollY + layout.viewport - obstruction + 2;
}

// Keep opening work small while retaining the user-message anchor used by chat motion.
export const CHAT_HISTORY_BATCH = 16;
export const CHAT_HISTORY_START_THRESHOLD = 96;

export function isNearChatHistoryStart(offsetY: number): boolean {
  "worklet";
  return Number.isFinite(offsetY) && offsetY <= CHAT_HISTORY_START_THRESHOLD;
}

export function shouldAutoLoadOlderChatHistory(
  offsetY: number,
  state: {
    userInitiated: boolean;
    historyVisible: boolean;
    canLoad: boolean;
    hasCachedOlder: boolean;
    olderError: boolean;
  },
): boolean {
  "worklet";
  return (
    state.userInitiated &&
    state.historyVisible &&
    state.canLoad &&
    (state.hasCachedOlder || !state.olderError) &&
    isNearChatHistoryStart(offsetY)
  );
}

export interface ChatHistoryBoundary {
  firstId: string | null;
  headId: string | null;
}

export function chatHistoryStart(
  messages: readonly { id: string }[],
  tailIndex: number,
  boundary: ChatHistoryBoundary,
): number {
  const previous = boundary.firstId ? messages.findIndex((message) => message.id === boundary.firstId) : -1;
  if (previous >= 0) {
    // A requested server page was prepended. Reveal its nearest batch immediately.
    if (boundary.firstId === boundary.headId && messages[0]?.id !== boundary.headId)
      return Math.max(0, previous - CHAT_HISTORY_BATCH);
    return previous;
  }
  const recent = Math.max(0, messages.length - CHAT_HISTORY_BATCH);
  return tailIndex >= 0 ? Math.min(recent, tailIndex) : recent;
}
