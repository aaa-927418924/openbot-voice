import { lstat, readFile } from "node:fs/promises";

const MAX_GLOBAL_AGENT_INSTRUCTIONS_BYTES = 64 * 1024;

/** Reads the administrator-owned AGENTS.md that applies to every Cloud-hosted agent. */
export async function readGlobalAgentInstructions(path: string): Promise<string | undefined> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Global AGENTS.md must be a regular file.");
  }
  if (metadata.size > MAX_GLOBAL_AGENT_INSTRUCTIONS_BYTES) {
    throw new Error("Global AGENTS.md exceeds the 64 KiB limit.");
  }

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  if (Buffer.byteLength(content, "utf8") > MAX_GLOBAL_AGENT_INSTRUCTIONS_BYTES) {
    throw new Error("Global AGENTS.md exceeds the 64 KiB limit.");
  }

  const instructions = content.replace(/^\uFEFF/u, "").trim();
  return instructions || undefined;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
