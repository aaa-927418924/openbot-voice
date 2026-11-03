import type { RemoteDeviceCommandPermission } from "@openbot/contracts/ipc";
import { DEVICE_COMMAND_ROUTES, DEVICE_COMMANDS_CAPABILITY } from "@openbot/contracts/team-protocol/device-commands-v1";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTeamApiFixture, stopTeamApiFixtures, type TeamApiOptions } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

const permission = (agentId: string): RemoteDeviceCommandPermission => ({
  agentId,
  commandsEnabled: true,
  computerUseEnabled: false,
  allowedExecutables: ["git"],
  allowedDirectories: ["/workspace"],
  updatedAt: "2026-11-03T00:00:00.000Z",
});

describe("Team API device commands", () => {
  it("lets a member use an existing grant but reserves grant changes for admins", async () => {
    const run = vi.fn(() =>
      Effect.succeed({ exitCode: 0, stdout: "clean", stderr: "", durationMs: 1, timedOut: false }),
    );
    const updatePermission = vi.fn((input: { agentId: string }) => Effect.succeed(permission(input.agentId)));
    const deviceCommands: NonNullable<TeamApiOptions["deviceCommands"]> = {
      info: () =>
        Effect.succeed({
          serverId: "target-linux",
          name: "Target Linux",
          platform: "linux",
          computerUseAvailable: false,
        }),
      getPermission: (agentId) => Effect.succeed(permission(agentId)),
      updatePermission,
      run,
      listComputerUseTools: () => Effect.succeed([]),
      callComputerUse: () => Effect.succeed({ success: true, contentItems: [] }),
    };
    const fixture = await createTeamApiFixture("device-commands", { configure: true });
    const { base } = await fixture.start({ deviceCommands });
    const ownerToken = await fixture.signIn();
    const invitation = await Effect.runPromise(fixture.store.createInvite("member"));
    const joined = await Effect.runPromise(fixture.store.acceptInvite(invitation.token, "alice", "member password"));
    const headers = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "OpenBot-Protocol-Version": "3",
      "OpenBot-Capabilities": DEVICE_COMMANDS_CAPABILITY,
      "Content-Type": "application/json",
    });

    const target = await fetch(`${base}${DEVICE_COMMAND_ROUTES.info}`, { headers: headers(joined.sessionToken) });
    expect(target.status).toBe(200);
    await expect(target.json()).resolves.toMatchObject({ serverId: "target-linux", platform: "linux" });

    const grant = await fetch(`${base}${DEVICE_COMMAND_ROUTES.permissions}?agentId=worker`, {
      headers: headers(joined.sessionToken),
    });
    expect(grant.status).toBe(200);
    await expect(grant.json()).resolves.toMatchObject({ agentId: "worker", commandsEnabled: true });

    const result = await fetch(`${base}${DEVICE_COMMAND_ROUTES.run}`, {
      method: "POST",
      headers: headers(joined.sessionToken),
      body: JSON.stringify({ agentId: "worker", executable: "git", args: ["status"], workingDirectory: "/workspace" }),
    });
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toMatchObject({ stdout: "clean", timedOut: false });
    expect(run).toHaveBeenCalledOnce();

    const updateBody = {
      agentId: "worker",
      commandsEnabled: false,
      computerUseEnabled: false,
      allowedExecutables: [],
      allowedDirectories: [],
    };
    const deniedUpdate = await fetch(`${base}${DEVICE_COMMAND_ROUTES.updatePermissions}`, {
      method: "POST",
      headers: headers(joined.sessionToken),
      body: JSON.stringify(updateBody),
    });
    expect(deniedUpdate.status).toBe(403);
    expect(updatePermission).not.toHaveBeenCalled();

    const allowedUpdate = await fetch(`${base}${DEVICE_COMMAND_ROUTES.updatePermissions}`, {
      method: "POST",
      headers: headers(ownerToken),
      body: JSON.stringify(updateBody),
    });
    expect(allowedUpdate.status).toBe(200);
    expect(updatePermission).toHaveBeenCalledOnce();
  });
});
