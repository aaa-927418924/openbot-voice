import { describe, expect, it } from "vitest";
import { remoteDesktopViewerUrl } from "./remote-desktop-viewer-url";

describe("remoteDesktopViewerUrl", () => {
  it("uses the account server address for a WebRTC viewer served from host loopback", () => {
    const result = new URL(
      remoteDesktopViewerUrl(
        {
          viewerUrl: "http://127.0.0.1:47990/v1/remote-screen/sessions/session-1/viewer?screen=1",
          viewerGrant: "grant",
        },
        { direct: false, baseUrl: "https://openbot.example.ts.net" },
      ),
    );

    expect(result.origin).toBe("https://openbot.example.ts.net");
    expect(result.pathname).toBe("/v1/remote-screen/sessions/session-1/viewer");
    expect(result.searchParams.get("screen")).toBe("1");
    expect(result.searchParams.get("openbotRelay")).toBe("1");
    expect(result.hash).toBe("#grant");
  });

  it("keeps a directly reachable viewer address and does not enable the WebRTC relay", () => {
    const result = new URL(
      remoteDesktopViewerUrl(
        { viewerUrl: "http://desktop.example.ts.net:47990/viewer?openbotRelay=1", viewerGrant: "grant" },
        { direct: true, baseUrl: "https://other.example.ts.net" },
      ),
    );

    expect(result.origin).toBe("http://desktop.example.ts.net:47990");
    expect(result.searchParams.has("openbotRelay")).toBe(false);
    expect(result.hash).toBe("#grant");
  });

  it("uses the API port when the account server exposes a non-default port", () => {
    const result = new URL(
      remoteDesktopViewerUrl(
        { viewerUrl: "http://localhost:47990/viewer", viewerGrant: "grant" },
        { direct: false, baseUrl: "http://100.100.10.2:43124" },
      ),
    );

    expect(result.origin).toBe("http://100.100.10.2:43124");
  });
});
