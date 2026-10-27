import { describe, expect, it } from "vitest";
import { decodeRemoteDesktopSession } from "./remote-desktop-session";

const session = {
  id: "session-1",
  serverId: "host-1",
  viewerUrl: "https://host.example/v1/remote-screen/sessions/session-1/viewer",
  viewerGrant: "single-use-grant",
  displays: [{ id: "display-1", label: "Main", width: 1920, height: 1080, primary: true }],
  selectedDisplayId: "display-1",
  phase: "connecting",
  transport: "unknown",
  errorCode: null,
  message: null,
  createdAt: "2026-10-27T00:00:00.000Z",
  grantExpiresAt: "2026-10-27T00:01:00.000Z",
};

describe("decodeRemoteDesktopSession", () => {
  it("keeps the validated viewer URL, one-time grant, and display metadata", () => {
    expect(decodeRemoteDesktopSession(session)).toMatchObject({
      viewerUrl: session.viewerUrl,
      viewerGrant: session.viewerGrant,
      displays: session.displays,
    });
  });

  it("rejects non-web viewer URLs before loading them in the app", () => {
    expect(() => decodeRemoteDesktopSession({ ...session, viewerUrl: "javascript:alert(1)" })).toThrow(
      "The host returned an invalid remote desktop session.",
    );
  });

  it("rejects incomplete display metadata", () => {
    expect(() => decodeRemoteDesktopSession({ ...session, displays: [{ id: "display-1" }] })).toThrow(
      "The host returned an invalid remote desktop display.",
    );
  });
});
