// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProfileName } from "@openbot/contracts/validation";
import { afterEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { LocalProfileStore } from "./local-profile-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalProfileStore", () => {
  it("does not persist a machine-name profile when a new install loads", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-profile-empty-"));
    roots.push(root);
    const path = join(root, "profile.json");
    const profile = new LocalProfileStore(path);

    await runCauseEffect(profile.load());

    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a display name locally without an email account", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-profile-"));
    roots.push(root);
    const path = join(root, "profile.json");
    const profile = new LocalProfileStore(path);
    await runCauseEffect(profile.load());

    const initialName = profile.getUser().name;
    expect(validateProfileName(initialName ?? "").error).toBeNull();
    await runCauseEffect(profile.updateName("My OpenBot"));

    const restored = new LocalProfileStore(path);
    await runCauseEffect(restored.load());
    expect(restored.getUser()).toMatchObject({ id: profile.getUser().id, email: "", name: "My OpenBot" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1, name: "My OpenBot" });
  });
});
