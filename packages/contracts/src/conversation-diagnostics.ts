// A payload-free record of the conversation sync path, shared by main and the renderer. A support
// export can then answer whether a remote client received the end of a reply, which a provider log
// cannot: the record holds lengths, revisions and a short fingerprint instead of any message text.

import { isDynamicRecord } from "./runtime-values";

/** One flat record. Every field is optional except `kind`, because each kind fills its own subset. */
export interface ConversationDiagnosticEvent {
  kind: string;
  /** Short fingerprints, never ids. */
  agent?: string;
  server?: string;
  source?: "ipc" | "refresh";
  revision?: number;
  requestedRevision?: number;
  pageRevision?: number;
  previousRevision?: number | null;
  messages?: number;
  latestId?: string | null;
  latestLength?: number | null;
  latestTag?: string | null;
  latestStatus?: string | null;
  merge?: string;
  windowMode?: string | null;
  applied?: boolean;
  deltaLength?: number;
  bodyBefore?: number;
  bodyAfter?: number;
  messageId?: string;
  entries?: string;
  turn?: string;
  status?: string;
  reason?: "turn_completed" | "runtime_snapshot" | "focus" | "reconnect";
  message?: string;
  anchor?: string;
  limit?: number;
}

const KINDS = new Set([
  "page_received",
  "page_refresh_discarded",
  "page_applied",
  "delta",
  "runtime_messages",
  "turn_completed",
  "resync",
  "page_failed",
]);

const STRING_FIELDS = [
  "agent",
  "server",
  "latestId",
  "latestTag",
  "latestStatus",
  "merge",
  "windowMode",
  "messageId",
  "entries",
  "turn",
  "status",
  "message",
  "anchor",
] as const;
const NUMBER_FIELDS = [
  "revision",
  "requestedRevision",
  "pageRevision",
  "previousRevision",
  "messages",
  "latestLength",
  "deltaLength",
  "bodyBefore",
  "bodyAfter",
  "limit",
] as const;
const BOOLEAN_FIELDS = ["applied"] as const;

/**
 * Reads a value that crossed a boundary (the renderer's IPC call) into the record shape. Unknown
 * fields, wrong types and unknown kinds are dropped rather than stored, so a record can never carry
 * a message body or an identifier by accident.
 */
export function parseConversationDiagnosticEvent(value: unknown): ConversationDiagnosticEvent | null {
  if (!isDynamicRecord(value)) return null;
  const record = value;
  const kind = record.kind;
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  const event: ConversationDiagnosticEvent = { kind };
  for (const field of STRING_FIELDS) {
    const entry = record[field];
    if (typeof entry === "string" && entry.length <= 500) event[field] = entry;
    else if (entry === null && (field === "latestId" || field === "latestTag" || field === "latestStatus")) {
      event[field] = null;
    }
  }
  for (const field of NUMBER_FIELDS) {
    const entry = record[field];
    if (typeof entry === "number" && Number.isFinite(entry)) event[field] = entry;
    else if (entry === null && (field === "latestLength" || field === "previousRevision")) event[field] = null;
  }
  for (const field of BOOLEAN_FIELDS) {
    const entry = record[field];
    if (typeof entry === "boolean") event[field] = entry;
  }
  if (record.source === "ipc" || record.source === "refresh") event.source = record.source;
  if (
    record.reason === "turn_completed" ||
    record.reason === "runtime_snapshot" ||
    record.reason === "focus" ||
    record.reason === "reconnect"
  ) {
    event.reason = record.reason;
  }
  return event;
}

/** A stable short fingerprint of ids and text, so two logs can be compared without either holding the value. */
export function conversationTextTag(value: string): string {
  // FNV-1a, 32 bit: enough to tell two message bodies apart across one support export.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
