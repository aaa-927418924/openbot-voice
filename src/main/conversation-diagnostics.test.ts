import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeConversationDiagnostics,
  readConversationDiagnostics,
  recordConversationDiagnostic,
  recordRendererConversationDiagnostic,
} from "./conversation-diagnostics";

const directories: string[] = [];

async function logDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-conversation-diagnostics-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("conversation diagnostics", () => {
  it("writes main and renderer records as NDJSON", async () => {
    initializeConversationDiagnostics(await logDirectory());
    recordConversationDiagnostic({
      kind: "page_received",
      source: "ipc",
      agent: "abc12345",
      latestLength: 2398,
      latestTag: "0badc0de",
    });
    recordRendererConversationDiagnostic({ kind: "delta", agent: "abc12345", applied: true, bodyAfter: 2398 });

    const text = await readConversationDiagnostics();
    const lines = text.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"kind":"page_received"');
    expect(lines[0]).toContain('"source":"ipc"');
    expect(lines[0]).toContain('"latestLength":2398');
    expect(lines[1]).toContain('"kind":"delta"');
    expect(lines[1]).toContain('"renderer":true');
    expect(lines[1]).toContain('"applied":true');
  });

  it("redacts credentials instead of storing the raw failure", async () => {
    initializeConversationDiagnostics(await logDirectory());
    recordConversationDiagnostic({
      kind: "page_failed",
      agent: "abc12345",
      message: "Authorization: Bearer secret-token-123456",
    });

    const text = await readConversationDiagnostics();

    expect(text).toContain("page_failed");
    expect(text).not.toContain("secret-token-123456");
  });
});
