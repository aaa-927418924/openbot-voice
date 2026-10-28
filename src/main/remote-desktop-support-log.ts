export type RemoteViewerDiagnosticEventName =
  | "session_request_started"
  | "session_created"
  | "session_request_failed"
  | "viewer_frame_loaded"
  | "viewer_state"
  | "http_request"
  | "http_response"
  | "http_error"
  | "websocket_rejected"
  | "websocket_upgrade"
  | "stream_opened"
  | "stream_closed"
  | "stream_error";

export type RemoteViewerDiagnosticResource =
  | "viewer"
  | "authorize"
  | "viewer_state"
  | "moonlight"
  | "screen_stream"
  | "browser_view_stream"
  | "other";

export interface RemoteViewerDiagnosticEvent {
  at: string;
  event: RemoteViewerDiagnosticEventName;
  resource?: RemoteViewerDiagnosticResource;
  method?: string;
  viewerGrantPresent?: boolean;
  status?: number;
  durationMs?: number;
  code?: number;
  transport?: "direct" | "webrtc-v2";
  viewerState?: "connecting" | "connected" | "error";
}

const EVENT_NAMES = [
  "session_request_started",
  "session_created",
  "session_request_failed",
  "viewer_frame_loaded",
  "viewer_state",
  "http_request",
  "http_response",
  "http_error",
  "websocket_rejected",
  "websocket_upgrade",
  "stream_opened",
  "stream_closed",
  "stream_error",
] as const satisfies readonly RemoteViewerDiagnosticEventName[];
const RESOURCE_NAMES = [
  "viewer",
  "authorize",
  "viewer_state",
  "moonlight",
  "screen_stream",
  "browser_view_stream",
  "other",
] as const;
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"] as const;

interface RawDiagnosticEvent {
  at?: unknown;
  event?: unknown;
  resource?: unknown;
  method?: unknown;
  viewerGrantPresent?: unknown;
  status?: unknown;
  durationMs?: unknown;
  code?: unknown;
  transport?: unknown;
  viewerState?: unknown;
}

/**
 * Reconstructs a text report from the proxy's allowlisted JSON events. Parsing and formatting each
 * field again ensures the exported file cannot leak a URL, session id, grant, or raw error even if
 * the log file contains an unexpected line.
 */
export function formatRemoteDesktopSupportLog(input: {
  generatedAt: string;
  appVersion: string;
  platform: string;
  log: string;
}): string {
  const lines = input.log
    .split(/\r?\n/u)
    .map(parseEventLine)
    .filter((event): event is RemoteViewerDiagnosticEvent => event !== null)
    .map(formatEventLine);
  return [
    "OpenBot remote desktop support log",
    `Generated: ${safeHeaderValue(input.generatedAt)}`,
    `OpenBot version: ${safeHeaderValue(input.appVersion)}`,
    `Platform: ${safeHeaderValue(input.platform)}`,
    "Privacy: Viewer grants, session IDs, URLs, account details, local paths, and raw errors are excluded.",
    `Events: ${lines.length}`,
    "",
    ...(lines.length
      ? lines
      : ["No remote viewer events have been recorded yet. Reproduce the connection issue and export this file again."]),
    "",
  ].join("\n");
}

function parseEventLine(line: string): RemoteViewerDiagnosticEvent | null {
  if (line.length === 0 || line.length > 2_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRawDiagnosticEvent(value)) return null;
  const record = value;
  let canonicalTimestamp = false;
  if (typeof record.at === "string") {
    try {
      canonicalTimestamp = new Date(record.at).toISOString() === record.at;
    } catch {
      canonicalTimestamp = false;
    }
  }
  if (typeof record.at !== "string" || !canonicalTimestamp || !isEventName(record.event)) {
    return null;
  }
  const event: RemoteViewerDiagnosticEvent = {
    at: record.at,
    event: record.event,
  };
  if (isResourceName(record.resource)) event.resource = record.resource;
  if (isHttpMethod(record.method)) event.method = record.method;
  if (typeof record.viewerGrantPresent === "boolean") event.viewerGrantPresent = record.viewerGrantPresent;
  if (record.transport === "direct" || record.transport === "webrtc-v2") event.transport = record.transport;
  if (record.viewerState === "connecting" || record.viewerState === "connected" || record.viewerState === "error")
    event.viewerState = record.viewerState;
  if (
    typeof record.status === "number" &&
    Number.isInteger(record.status) &&
    record.status >= 100 &&
    record.status <= 599
  )
    event.status = record.status;
  if (typeof record.durationMs === "number" && Number.isInteger(record.durationMs) && record.durationMs >= 0)
    event.durationMs = record.durationMs;
  if (typeof record.code === "number" && Number.isInteger(record.code) && record.code >= 0 && record.code <= 4999)
    event.code = record.code;
  return event;
}

function isRawDiagnosticEvent(value: unknown): value is RawDiagnosticEvent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventName(value: unknown): value is RemoteViewerDiagnosticEventName {
  return typeof value === "string" && EVENT_NAMES.some((name) => name === value);
}

function isResourceName(value: unknown): value is RemoteViewerDiagnosticResource {
  return typeof value === "string" && RESOURCE_NAMES.some((name) => name === value);
}

function isHttpMethod(value: unknown): value is (typeof HTTP_METHODS)[number] {
  return typeof value === "string" && HTTP_METHODS.some((method) => method === value);
}

function formatEventLine(event: RemoteViewerDiagnosticEvent): string {
  const fields = [
    event.resource ? `resource=${event.resource}` : undefined,
    event.method ? `method=${event.method}` : undefined,
    event.viewerGrantPresent !== undefined ? `viewerGrantPresent=${event.viewerGrantPresent}` : undefined,
    event.status !== undefined ? `status=${event.status}` : undefined,
    event.durationMs !== undefined ? `durationMs=${event.durationMs}` : undefined,
    event.code !== undefined ? `code=${event.code}` : undefined,
    event.transport ? `transport=${event.transport}` : undefined,
    event.viewerState ? `viewerState=${event.viewerState}` : undefined,
  ].filter((field): field is string => field !== undefined);
  return `${event.at} ${event.event}${fields.length ? ` ${fields.join(" ")}` : ""}`;
}

function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n\t]/gu, " ").slice(0, 128);
}
