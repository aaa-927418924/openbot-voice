// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RemoteServerConnectionStatus } from "./remote-server-connection-status";
import { remoteServerSummaries } from "./remote-server-summaries";

const connectedCloudStatus: RemoteServerConnectionStatus = {
  state: "online",
  compatibility: {
    localAppVersion: "0.30.0",
    hostAppVersion: "0.30.0",
    origin: "cloud",
    localProtocol: { minimum: 1, maximum: 6 },
    hostProtocol: { minimum: 1, maximum: 6 },
    negotiatedProtocol: 6,
    capabilities: [],
  },
  issue: null,
  connectionSequence: 1,
  hostRestart: null,
  hostedSleep: null,
};

describe("remote server summaries", () => {
  it("marks a connected Cloud host from compatibility metadata, not its display name", () => {
    const summaries = remoteServerSummaries(
      [
        {
          id: "cloud-host",
          name: "Renamed TUI server",
          apiUrl: "http://100.100.10.2:43125/",
          fingerprint: "a".repeat(43),
          username: "device-user",
          encryptedToken: "encrypted-token",
          remoteDesktopAvailable: true,
          role: "owner",
        },
        {
          id: "named-only",
          name: "OpenBot Cloud",
          apiUrl: "http://100.100.10.3:43123/",
          fingerprint: "b".repeat(43),
          username: "device-user",
          encryptedToken: "encrypted-token",
          remoteDesktopAvailable: true,
          role: "owner",
        },
      ],
      "cloud-host",
      (serverId) =>
        serverId === "cloud-host" ? connectedCloudStatus : { ...connectedCloudStatus, compatibility: null },
    );

    expect(summaries.find((server) => server.id === "cloud-host")).toMatchObject({
      name: "Renamed TUI server",
      origin: "cloud",
    });
    expect(summaries.find((server) => server.id === "named-only")).not.toHaveProperty("origin");
  });
});
