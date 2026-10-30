// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { ensureLocalHostConfigured } from "./local-host-setup";
import { TeamStore } from "./team-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ensureLocalHostConfigured", () => {
  it("creates a host bound to the signed-in account instead of leaving it adoptable", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-host-setup-"));
    roots.push(root);
    const path = join(root, "team.json");
    const store = new TeamStore(path);
    await runCauseEffect(store.initialize());

    await ensureLocalHostConfigured(store, "OpenBot", "owner password", "owner-account", null);

    expect(store.getOwnerAccountId()).toBe("owner-account");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ activeAccountId: "owner-account" });
  });

  it("does not create a host after the signed-in account changes during setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-host-setup-"));
    roots.push(root);
    const path = join(root, "team.json");
    const store = new TeamStore(path);
    await runCauseEffect(store.initialize());
    let checks = 0;

    // The existing-host lookup yields once; changing the account there must abort before creating.
    const pending = ensureLocalHostConfigured(
      store,
      "OpenBot",
      "owner password",
      "old-account",
      null,
      () => ++checks === 1,
    );

    await expect(pending).rejects.toThrow("signed-in account changed");
    expect(store.configured).toBe(false);
    expect(await readFile(path, "utf8").catch(() => "")).toBe("");
  });

  it("reactivates the saved host without replacing its name or identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-local-host-setup-"));
    roots.push(root);
    const path = join(root, "team.json");
    const original = new TeamStore(path);
    await runCauseEffect(original.initialize());
    const identity = await runCauseEffect(original.configure("OpenBot", "owner", "correct horse battery"));
    const profile = { id: "owner-account", email: "", name: "Owner", avatarUrl: null };
    await runCauseEffect(original.syncSelfHostedOwner(profile));
    await runCauseEffect(original.activateLocalHost(profile.id));

    const persisted: { activeAccountId: string | null } = JSON.parse(await readFile(path, "utf8"));
    persisted.activeAccountId = "signed-out-profile-id";
    await writeFile(path, JSON.stringify(persisted));

    const restarted = new TeamStore(path);
    await runCauseEffect(restarted.initialize());
    expect(restarted.configured).toBe(false);

    await ensureLocalHostConfigured(restarted, "FMVA45B2B", "new owner password", profile.id, null);

    expect(restarted.getIdentity()).toMatchObject({ serverId: identity.serverId, serverName: "OpenBot" });
    expect(restarted.configured).toBe(true);
  });
});
