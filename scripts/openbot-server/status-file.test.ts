// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readServerStatus, statusFilePath, writeServerStatus } from "./status-file";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenBot server status file", () => {
  it("stores only sanitized device and host status in a private runtime directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-server-status-"));
    roots.push(root);
    const path = statusFilePath(join(root, "runtime"));
    await writeServerStatus(path, {
      version: 1,
      state: "running",
      startedAt: 10,
      updatedAt: 20,
      apiUrl: "http://100.100.10.2:43124",
      devices: [{ deviceName: "Pixel 7a", platform: "android", connectedAt: 11, expiresAt: 100 }],
      host: { cpuPercent: 12, memoryUsedBytes: 20, memoryTotalBytes: 100, gpu: "NVIDIA GPU · 1%" },
    });

    const status = await readServerStatus(path);
    const encoded = await readFile(path, "utf8");
    const fileMode = (await stat(path)).mode & 0o777;
    const directoryMode = (await stat(join(root, "runtime"))).mode & 0o777;

    expect(status?.devices[0]?.deviceName).toBe("Pixel 7a");
    expect(JSON.parse(encoded)).not.toHaveProperty("messages");
    expect(JSON.parse(encoded)).not.toHaveProperty("email");
    expect(JSON.parse(encoded)).not.toHaveProperty("token");
    expect(fileMode).toBe(0o600);
    expect(directoryMode).toBe(0o700);
  });

  it("rejects malformed status rather than rendering unchecked file contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-server-status-invalid-"));
    roots.push(root);
    const path = statusFilePath(root);
    await writeServerStatus(path, {
      version: 1,
      state: "running",
      startedAt: 10,
      updatedAt: 20,
      apiUrl: null,
      devices: [],
      host: null,
    });
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(path, JSON.stringify({ version: 1, state: "running", updatedAt: "bad" })),
    );

    await expect(readServerStatus(path)).resolves.toBeNull();
  });
});
