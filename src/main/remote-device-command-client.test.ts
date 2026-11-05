import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { RemoteDeviceCommandClient } from "./remote-device-command-client";
import { RemoteRequestError } from "./remote-server-errors";
import { RemoteWorkflowError } from "./remote-service-effects";

describe("RemoteDeviceCommandClient", () => {
  it("refreshes an expired account session once before listing a shared device", async () => {
    const request = vi.fn();
    request
      .mockReturnValueOnce(
        Effect.fail(new RemoteWorkflowError({ cause: new RemoteRequestError(401, "expired session") })),
      )
      .mockReturnValueOnce(
        Effect.succeed({
          serverId: "windows-host",
          name: "DESKTOP-TEST (Windows)",
          deviceName: "DESKTOP-TEST",
          platform: "windows",
          computerUseAvailable: true,
          localReviewAvailable: true,
        }),
      )
      .mockReturnValueOnce(Effect.succeed({ commandsEnabled: true, computerUseEnabled: true, updatedAt: null }));
    const refreshAccountSession = vi.fn(async () => undefined);
    const servers = {
      listDeviceCommandServers: () => [{ id: "windows-host", state: "offline", deviceOnly: true }],
      supportsCapability: () => true,
      ensureCapability: () => Effect.succeed(true),
      request,
    } satisfies ConstructorParameters<typeof RemoteDeviceCommandClient>[0];
    const client = new RemoteDeviceCommandClient(servers, null, null, {
      cloudHostMode: true,
      refreshAccountSession,
    });

    await expect(client.listTargetsForAgent("browser-agent")).resolves.toMatchObject([
      {
        serverId: "windows-host",
        name: "DESKTOP-TEST (Windows)",
        platform: "windows",
        state: "online",
        policy: { commandsEnabled: true, computerUseEnabled: true },
      },
    ]);
    expect(refreshAccountSession).toHaveBeenCalledExactlyOnceWith("windows-host");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
