// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalServerPreferenceStore } from "./local-server-preference-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalServerPreferenceStore", () => {
  it("defaults to enabled and keeps a disabled value across restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-server-preference-"));
    roots.push(root);
    const path = join(root, "preference.json");
    const first = new LocalServerPreferenceStore(path);
    await first.initialize();
    expect(first.enabled).toBe(true);
    await first.setEnabled(false);

    const restarted = new LocalServerPreferenceStore(path);
    await restarted.initialize();
    expect(restarted.enabled).toBe(false);
  });

  it("does not re-enable the server when its preference file is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-server-preference-corrupt-"));
    roots.push(root);
    const path = join(root, "preference.json");
    await writeFile(path, "{", "utf8");

    const store = new LocalServerPreferenceStore(path);
    await store.initialize();

    expect(store.enabled).toBe(false);
  });

  it("does not re-enable the server when its preference file has the wrong shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-server-preference-invalid-"));
    roots.push(root);
    const path = join(root, "preference.json");
    await writeFile(path, JSON.stringify({ version: 1, enabled: "false" }), "utf8");

    const store = new LocalServerPreferenceStore(path);
    await store.initialize();

    expect(store.enabled).toBe(false);
  });
});
