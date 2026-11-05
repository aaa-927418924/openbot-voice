import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteDeviceCommandHost } from "./remote-device-command-host";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RemoteDeviceCommandHost", () => {
  it("keeps command and Computer Use grants off until an admin enables them", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "openbot-device-command-host-"));
    roots.push(userDataPath);
    const host = new RemoteDeviceCommandHost({
      userDataPath,
      getServerId: () => "target-linux",
      getServerName: () => "Target Linux",
      cuaDriver: { mcpServerForProviders: () => null },
      platform: "linux",
    });

    await expect(Effect.runPromise(host.getPermission("agent-1"))).resolves.toMatchObject({
      commandsEnabled: false,
      computerUseEnabled: false,
      allowedExecutables: [],
      allowedDirectories: [],
    });

    const run = await Effect.runPromise(
      Effect.result(
        host.run({ agentId: "agent-1", executable: "echo", args: ["hello"], workingDirectory: userDataPath }),
      ),
    );
    expect(Result.isFailure(run)).toBe(true);
    if (Result.isFailure(run)) expect(run.failure.cause).toMatchObject({ message: "permission" });

    const computerUse = await Effect.runPromise(Effect.result(host.listComputerUseTools("agent-1")));
    expect(Result.isFailure(computerUse)).toBe(true);
    if (Result.isFailure(computerUse)) expect(computerUse.failure.cause).toMatchObject({ message: "permission" });
  });

  it("executes an allowed command after local review without invoking Codex AutoReview", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "openbot-device-command-local-review-"));
    roots.push(userDataPath);
    const autoReviewAvailable = vi.fn(async () => false);
    const autoReviewRun = vi.fn(async () => {
      throw new Error("Codex AutoReview must not be called.");
    });
    const host = new RemoteDeviceCommandHost({
      userDataPath,
      getServerId: () => "target-linux",
      getServerName: () => "Target Linux",
      cuaDriver: { mcpServerForProviders: () => null },
      platform: "linux",
      autoReview: { available: autoReviewAvailable, run: autoReviewRun },
    });

    await Effect.runPromise(host.updatePolicy({ commandsEnabled: true, computerUseEnabled: false }));
    await expect(
      Effect.runPromise(
        host.runWithLocalReview({
          agentId: "agent-1",
          executable: "hostname",
          args: [],
          workingDirectory: userDataPath,
        }),
      ),
    ).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    expect(autoReviewAvailable).not.toHaveBeenCalled();
    expect(autoReviewRun).not.toHaveBeenCalled();

    const blocked = await Effect.runPromise(
      Effect.result(
        host.runWithLocalReview({
          agentId: "agent-1",
          executable: "python",
          args: ["-c", "print(1)"],
          workingDirectory: userDataPath,
        }),
      ),
    );
    expect(Result.isFailure(blocked)).toBe(true);
    if (Result.isFailure(blocked)) expect(blocked.failure.cause).toMatchObject({ message: "review" });
    expect(autoReviewRun).not.toHaveBeenCalled();
  });
});
