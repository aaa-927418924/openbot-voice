import type { RemoteDesktopSession } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { RemoteDesktopManager } from "./remote-desktop-manager";
import { RemoteProtocolError, RemoteRequestError } from "./remote-server-errors";
import { remoteCall } from "./remote-service-effects";

const session: RemoteDesktopSession = {
  id: "desktop-1",
  serverId: "remote-1",
  viewerUrl: "https://studio.example.com/v1/remote-screen/sessions/desktop-1/viewer",
  viewerGrant: "viewer-grant",
  displays: [],
  selectedDisplayId: null,
  phase: "connecting",
  transport: "unknown",
  errorCode: null,
  message: "Connecting…",
  createdAt: "2026-08-21T12:00:00.000Z",
  grantExpiresAt: "2026-08-21T12:01:00.000Z",
};

function createManager(
  createRemoteDesktopSession: () => Promise<RemoteDesktopSession>,
  onDiagnostic?: (event: import("./remote-desktop-support-log").RemoteViewerDiagnosticEvent) => void,
) {
  return new RemoteDesktopManager(
    {
      createRemoteDesktopSession: () => remoteCall(createRemoteDesktopSession),
      closeRemoteDesktopSession: vi.fn(() => Effect.void),
      selectRemoteDesktopDisplay: vi.fn(() => Effect.void),
    },
    onDiagnostic,
  );
}

describe("RemoteDesktopManager.connect", () => {
  it("hands the renderer the host's own reason, because an IPC rejection carries no code", async () => {
    const manager = createManager(async () => {
      throw new RemoteRequestError(
        503,
        "The host has not allowed OpenBot to record its screen.",
        "host_permissions_required",
      );
    });

    await expect(runCauseEffect(manager.connect({ serverId: "remote-1" }))).resolves.toEqual({
      status: "refused",
      errorCode: "host_permissions_required",
      message: "The host has not allowed OpenBot to record its screen.",
    });
    expect(manager.list()).toEqual([]);
  });

  it("keeps a broken call a rejection, so a refusal stays the only named answer", async () => {
    const manager = createManager(async () => {
      throw new RemoteProtocolError("host_update_required", "Update OpenBot on the host.");
    });

    await expect(runCauseEffect(manager.connect({ serverId: "remote-1" }))).rejects.toThrow(
      "Update OpenBot on the host.",
    );
  });

  it("answers a session the host opened", async () => {
    const manager = createManager(async () => structuredClone(session));

    await expect(runCauseEffect(manager.connect({ serverId: "remote-1" }))).resolves.toEqual({
      status: "connected",
      session,
    });
    expect(manager.list()).toEqual([session]);
  });

  it("records only allowlisted viewer state for an active session", async () => {
    const onDiagnostic = vi.fn();
    const manager = createManager(async () => structuredClone(session), onDiagnostic);
    await runCauseEffect(manager.connect({ serverId: "remote-1" }));

    manager.reportViewerDiagnostic({ serverId: "remote-1", event: "frame_loaded" });
    manager.reportViewerDiagnostic({ serverId: "remote-1", event: "error" });
    manager.reportViewerDiagnostic({ serverId: "unknown-server", event: "connected" });

    expect(onDiagnostic).toHaveBeenCalledTimes(2);
    expect(onDiagnostic).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ event: "viewer_frame_loaded", resource: "viewer" }),
    );
    expect(onDiagnostic).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ event: "viewer_state", resource: "viewer", viewerState: "error" }),
    );
  });
});
