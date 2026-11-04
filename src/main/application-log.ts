import { teeLogLines } from "@openbot/logging";
import { Effect } from "effect";
import { appendRemoteDiagnosticLog } from "./remote-diagnostics";

/** Writes redacted OpenBot logger output to a file that can be collected without using the UI. */
export function startApplicationLog(logsDirectory: string): () => void {
  return teeLogLines(["*"], (line) => {
    Effect.runFork(appendRemoteDiagnosticLog(logsDirectory, "openbot", `${line}\n`));
  });
}
