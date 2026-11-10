// The main-process half of the conversation diagnostics: an append-only NDJSON file in the log
// directory. It holds lengths, revisions and short fingerprints, never message text, and it is
// included in the support export so a remote client's view of a reply can be compared with what
// the host served.

import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationDiagnosticEvent } from "@openbot/contracts/conversation-diagnostics";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { redactText } from "@openbot/logging";

const FILE_NAME = "conversation.ndjson";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024;
const MAX_PENDING_LINES = 256;
const FLUSH_DELAY_MS = 500;

let logDirectory: string | null = null;
let pending: string[] = [];
let timer: NodeJS.Timeout | null = null;
let writes: Promise<void> = Promise.resolve();

/** Points the recorder at the app's log directory. Before this call every record is dropped. */
export function initializeConversationDiagnostics(directory: string): void {
  logDirectory = directory;
}

export function recordConversationDiagnostic(event: ConversationDiagnosticEvent): void {
  appendRedacted({ at: new Date().toISOString(), ...event });
}

/** A record the renderer sent over IPC, already narrowed to the flat shape at the boundary. */
export function recordRendererConversationDiagnostic(event: ConversationDiagnosticEvent): void {
  appendRedacted({ at: new Date().toISOString(), renderer: true, ...event });
}

function appendRedacted(record: DynamicRecord): void {
  if (!logDirectory) return;
  let line: string;
  try {
    line = redactText(JSON.stringify(record)).replace(/\r?\n/gu, " ");
  } catch {
    return;
  }
  if (line.length === 0 || line.length > MAX_LINE_BYTES) return;
  if (pending.length >= MAX_PENDING_LINES) pending.shift();
  pending.push(line);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_DELAY_MS);
  timer.unref?.();
}

async function flush(): Promise<void> {
  if (!logDirectory) return;
  const lines = pending;
  pending = [];
  if (lines.length === 0) return;
  const directory = logDirectory;
  writes = writes
    .then(async () => {
      await mkdir(directory, { recursive: true });
      const path = join(directory, FILE_NAME);
      await rotateIfNeeded(path);
      await appendFile(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    })
    .catch(() => undefined);
  await writes;
}

/** Writes what is pending, so an export that follows includes the latest records. */
export async function flushConversationDiagnostics(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
}

async function rotateIfNeeded(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if (info.size < MAX_FILE_BYTES) return;
    await rename(path, `${path}.1`);
  } catch {
    // A missing file is the normal first write.
  }
}

/** The newest records, oldest first, for the support export. */
export async function readConversationDiagnostics(limitBytes = 1_048_576): Promise<string> {
  if (!logDirectory) return "";
  await flushConversationDiagnostics();
  const path = join(logDirectory, FILE_NAME);
  const [previous, current] = await Promise.all([readTail(`${path}.1`, limitBytes), readTail(path, limitBytes)]);
  return [previous, current].filter((part) => part.length > 0).join("\n");
}

async function readTail(path: string, limitBytes: number): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return text.length > limitBytes ? text.slice(-limitBytes) : text;
  } catch {
    return "";
  }
}
