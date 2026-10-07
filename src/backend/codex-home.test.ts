// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexHome, codexProcessEnv } from "./codex-home";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-codex-home-"));
  temporaryRoots.push(root);
  return root;
}

describe("CodexHome", () => {
  it("points at codex-home inside the given userData path", async () => {
    const userDataPath = await temporaryRoot();
    expect(new CodexHome({ userDataPath }).path).toBe(join(userDataPath, "codex-home"));
  });

  it("creates the directory on ensure", async () => {
    const home = new CodexHome({ userDataPath: await temporaryRoot() });
    const { mkdir } = await import("node:fs/promises");
    await expect(mkdir(home.ensure(), { recursive: true })).resolves.toBeUndefined();
  });

  it("sets both Codex variables to the same directory", async () => {
    const home = new CodexHome({ userDataPath: await temporaryRoot() });
    const env = home.processEnv({ PATH: "/usr/bin" });
    expect(env.CODEX_HOME).toBe(home.path);
    expect(env.CODEX_SQLITE_HOME).toBe(home.path);
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("codexProcessEnv", () => {
  it("leaves the environment alone without a home", () => {
    const base = { PATH: "/usr/bin" };
    expect(codexProcessEnv(undefined, base)).toBe(base);
  });

  it("throws instead of falling back when the home cannot be created", async () => {
    const blocker = join(await temporaryRoot(), "blocker");
    await writeFile(blocker, "not a directory");
    expect(() => codexProcessEnv(join(blocker, "codex-home"), {})).toThrow();
  });
});
