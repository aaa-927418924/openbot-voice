import { join } from "node:path";
import { teeLogLines } from "@openbot/logging";
import { Effect } from "effect";
import { appendRemoteDiagnosticLog } from "./remote-diagnostics";

/**
 * The loggers whose lines also go to the provider log: provider starts, CLI checks, model lists,
 * state changes and errors (`provider-runtime`); runtime downloads (`provider-runtimes`); model
 * list members that the window refuses (`provider-models`); and safe Live Voice error origins
 * (`agent-error-origin`).
 */
const PROVIDER_LOG_PREFIXES = [
  "provider-runtime",
  "provider-runtimes",
  "provider-models",
  "agent-error-origin",
] as const;

/**
 * Keeps the provider lines in `<logs>/providers/providers.log`, 1 MB with one rotated copy. An app
 * started from the Dock has no terminal that keeps stdout, so this file is the only record of why a
 * provider failed. The logger already redacted each line, and the writer redacts it again. Returns
 * the removal.
 */
export function startProviderLog(logsDirectory: string): () => void {
  const directory = join(logsDirectory, "providers");
  return teeLogLines(PROVIDER_LOG_PREFIXES, (line) => {
    Effect.runFork(appendRemoteDiagnosticLog(directory, "providers", `${line}\n`));
  });
}
