import { describe, expect, it } from "vitest";
import { formatRemoteDesktopSupportLog } from "./remote-desktop-support-log";

describe("remote desktop support log export", () => {
  it("keeps only allowlisted connection facts and excludes secrets and identifiers", () => {
    const log = [
      JSON.stringify({
        at: "2026-10-28T12:00:00.000Z",
        event: "http_response",
        resource: "authorize",
        status: 401,
        durationMs: 12,
        grant: "viewer-secret-token",
        url: "https://host.example/private?invite=invite-secret",
        sessionId: "private-session-id",
        error: "Authorization: Bearer private-credential",
      }),
      JSON.stringify({
        at: "2026-10-28T12:00:01.000Z",
        event: "websocket_upgrade",
        resource: "screen_stream",
        viewerGrantPresent: true,
      }),
      '{"at":"2026-10-28T12:00:02.000Z","event":"unknown","token":"discard-me"}',
      "not-json",
    ].join("\n");
    const report = formatRemoteDesktopSupportLog({
      generatedAt: "2026-10-28T12:01:00.000Z",
      appVersion: "0.30.0",
      platform: "win32",
      log,
    });

    expect(report).toContain("Events: 2");
    expect(report).toContain("http_response resource=authorize status=401 durationMs=12");
    expect(report).toContain("websocket_upgrade resource=screen_stream viewerGrantPresent=true");
    for (const secret of [
      "viewer-secret-token",
      "host.example",
      "invite-secret",
      "private-session-id",
      "private-credential",
      "discard-me",
    ]) {
      expect(report).not.toContain(secret);
    }
  });

  it("explains that a connection attempt must be reproduced when no log exists", () => {
    const report = formatRemoteDesktopSupportLog({
      generatedAt: "2026-10-28T12:01:00.000Z",
      appVersion: "0.30.0",
      platform: "win32",
      log: "",
    });

    expect(report).toContain("Events: 0");
    expect(report).toContain("Reproduce the connection issue and export this file again.");
  });

  it("records direct viewer startup and state without including a session or grant", () => {
    const report = formatRemoteDesktopSupportLog({
      generatedAt: "2026-10-28T12:01:00.000Z",
      appVersion: "0.30.0",
      platform: "win32",
      log: [
        JSON.stringify({
          at: "2026-10-28T12:00:00.000Z",
          event: "session_request_started",
          resource: "viewer",
          transport: "direct",
        }),
        JSON.stringify({
          at: "2026-10-28T12:00:01.000Z",
          event: "session_created",
          resource: "viewer",
          transport: "direct",
          durationMs: 19,
          sessionId: "private-session-id",
          viewerGrant: "private-viewer-grant",
        }),
        JSON.stringify({
          at: "2026-10-28T12:00:02.000Z",
          event: "viewer_state",
          resource: "viewer",
          viewerState: "error",
        }),
      ].join("\n"),
    });

    expect(report).toContain("session_request_started resource=viewer transport=direct");
    expect(report).toContain("session_created resource=viewer durationMs=19 transport=direct");
    expect(report).toContain("viewer_state resource=viewer viewerState=error");
    expect(report).not.toContain("private-session-id");
    expect(report).not.toContain("private-viewer-grant");
  });
});
