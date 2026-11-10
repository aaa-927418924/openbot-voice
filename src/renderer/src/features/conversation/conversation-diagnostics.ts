// The renderer's records of the conversation sync path. They go to main over IPC, which appends
// them to the support log. Only lengths, revisions and short fingerprints are sent, never the text
// of a message.

import type { ConversationDiagnosticEvent } from "@openbot/contracts/conversation-diagnostics";
import { conversationTextTag } from "@openbot/contracts/conversation-diagnostics";
import type { AgentRuntimeSnapshot, ConversationPage } from "@openbot/contracts/ipc";
import { appPort } from "../../app-port";

function record(event: ConversationDiagnosticEvent): void {
  // A diagnostic must never surface as a chat error.
  void appPort()
    .maintenance.recordDiagnostic(event)
    .catch(() => undefined);
}

function latestFlags(page: ConversationPage) {
  const latest = page.messages.at(-1);
  return {
    latestId: latest ? conversationTextTag(latest.id) : null,
    latestLength: latest ? latest.text.length : null,
    latestTag: latest ? conversationTextTag(latest.text) : null,
    latestStatus: latest?.status ?? null,
  };
}

export function recordPageApplied(input: {
  agentId: string;
  merge: string;
  windowMode: string | null;
  page: ConversationPage;
  previousRevision: number | null;
  applied: boolean;
}): void {
  record({
    kind: "page_applied",
    agent: conversationTextTag(input.agentId),
    merge: input.merge,
    windowMode: input.windowMode,
    pageRevision: input.page.revision,
    previousRevision: input.previousRevision,
    applied: input.applied,
    messages: input.page.messages.length,
    ...latestFlags(input.page),
  });
}

export function recordDelta(input: {
  agentId: string;
  messageId: string;
  revision: number;
  applied: boolean;
  deltaLength: number;
  bodyBefore: number;
  bodyAfter: number;
}): void {
  record({
    kind: "delta",
    agent: conversationTextTag(input.agentId),
    messageId: conversationTextTag(input.messageId),
    revision: input.revision,
    applied: input.applied,
    deltaLength: input.deltaLength,
    bodyBefore: input.bodyBefore,
    bodyAfter: input.bodyAfter,
  });
}

export function recordRuntimeMessages(agentId: string, messages: AgentRuntimeSnapshot["latestMessages"]): void {
  const entries = messages
    .filter((message) => message.agentId === agentId)
    .map((message) => `${conversationTextTag(message.id)}:${message.text.length}:${conversationTextTag(message.text)}`);
  if (entries.length === 0) return;
  record({ kind: "runtime_messages", agent: conversationTextTag(agentId), entries: entries.join(",") });
}

export function recordTurnCompleted(agentId: string, turnId: string, status: string): void {
  record({
    kind: "turn_completed",
    agent: conversationTextTag(agentId),
    turn: conversationTextTag(turnId),
    status,
  });
}

export function recordResync(
  agentId: string,
  reason: "turn_completed" | "runtime_snapshot" | "focus" | "reconnect",
): void {
  record({ kind: "resync", agent: conversationTextTag(agentId), reason });
}

export function recordPageFailed(agentId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  record({
    kind: "page_failed",
    agent: conversationTextTag(agentId),
    message: message.replace(/\s+/gu, " ").slice(0, 200),
  });
}
