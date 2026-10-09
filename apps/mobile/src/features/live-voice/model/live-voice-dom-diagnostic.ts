import { z } from "zod";
import type { MobileLiveVoiceCommand } from "./live-voice-command";

export const LIVE_VOICE_DIAGNOSTIC_BUILD_ID = "android-live-voice-dom-probe-20261010-r1";
export const LIVE_VOICE_DOM_DIAGNOSTIC_TYPE = "openbot-live-voice-diagnostic";

const commandTypes = ["start", "stop", "toggle-mute", "resume-audio", "send-text", "host-event"] as const;
const stages = [
  "dom-mounted",
  "props-updated",
  "start-command-received",
  "controller-start-invoked",
  "controller-start-returned",
  "controller-start-threw",
  "webview-page-finished",
] as const;

export interface LiveVoiceDomDiagnosticInput {
  stage: (typeof stages)[number];
  active?: boolean;
  hasSessionId?: boolean;
  sessionMatches?: boolean;
  commandCount?: number;
  commandTypes?: MobileLiveVoiceCommand["type"][];
  hasProps?: boolean;
  hasBridge?: boolean;
}

const liveVoiceDomDiagnosticSchema = z
  .object({
    type: z.literal(LIVE_VOICE_DOM_DIAGNOSTIC_TYPE),
    buildId: z.literal(LIVE_VOICE_DIAGNOSTIC_BUILD_ID),
    stage: z.enum(stages),
    active: z.boolean().optional(),
    hasSessionId: z.boolean().optional(),
    sessionMatches: z.boolean().optional(),
    commandCount: z.number().int().nonnegative().max(32).optional(),
    commandTypes: z.array(z.enum(commandTypes)).max(32).optional(),
    hasProps: z.boolean().optional(),
    hasBridge: z.boolean().optional(),
  })
  .strict();

export type LiveVoiceDomDiagnostic = z.infer<typeof liveVoiceDomDiagnosticSchema>;

export function createLiveVoiceDomDiagnostic(input: LiveVoiceDomDiagnosticInput): LiveVoiceDomDiagnostic {
  return liveVoiceDomDiagnosticSchema.parse({
    type: LIVE_VOICE_DOM_DIAGNOSTIC_TYPE,
    buildId: LIVE_VOICE_DIAGNOSTIC_BUILD_ID,
    ...input,
  });
}

/** Reject arbitrary WebView messages and fields before they can enter the support log. */
export function parseLiveVoiceDomDiagnostic(message: string): LiveVoiceDomDiagnostic | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  const result = liveVoiceDomDiagnosticSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function formatLiveVoiceDomDiagnostic(diagnostic: LiveVoiceDomDiagnostic): string {
  const details = [
    diagnostic.active === undefined ? undefined : `active=${diagnostic.active}`,
    diagnostic.hasSessionId === undefined ? undefined : `hasSessionId=${diagnostic.hasSessionId}`,
    diagnostic.sessionMatches === undefined ? undefined : `sessionMatches=${diagnostic.sessionMatches}`,
    diagnostic.commandCount === undefined ? undefined : `commandCount=${diagnostic.commandCount}`,
    diagnostic.commandTypes === undefined ? undefined : `commands=${diagnostic.commandTypes.join(",") || "none"}`,
    diagnostic.hasProps === undefined ? undefined : `hasProps=${diagnostic.hasProps}`,
    diagnostic.hasBridge === undefined ? undefined : `hasBridge=${diagnostic.hasBridge}`,
  ].filter((detail) => detail !== undefined);

  return `Live Voice probe [${diagnostic.buildId}]: ${diagnostic.stage}${details.length ? ` (${details.join("; ")})` : ""}`;
}

export function isLiveVoiceDomDiagnosticWarning(diagnostic: LiveVoiceDomDiagnostic): boolean {
  return diagnostic.stage === "controller-start-threw";
}
