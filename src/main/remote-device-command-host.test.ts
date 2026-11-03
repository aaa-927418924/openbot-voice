import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { afterEach, describe, expect, it } from "vitest";
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
});
