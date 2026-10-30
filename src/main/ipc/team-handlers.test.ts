import type { HostStatus, ServerSummary } from "@openbot/contracts/ipc";
import { expect, it } from "vitest";
import { withLocalHostSummary } from "./team-handlers";

const localServer: ServerSummary = {
  id: "local",
  name: "Local",
  kind: "local",
  state: "online",
  apiUrl: null,
  remoteDesktopAvailable: false,
  logoUrl: null,
  role: null,
  active: true,
  notificationsMuted: false,
  notificationsMutedUntil: null,
  notificationLevel: "all",
};

const remoteServer: ServerSummary = {
  ...localServer,
  id: "remote-1",
  name: "Remote",
  kind: "remote",
  active: false,
};

const status: HostStatus = {
  phase: "idle",
  configured: false,
  enabledOnLaunch: false,
  serverId: null,
  serverName: "OpenBot host",
  apiUrl: null,
  logoUrl: null,
  apiOnline: false,
  remoteDesktopReady: false,
  remoteDesktopScreenRecordingDenied: false,
  remoteDesktopUnattended: false,
  remoteDesktopActiveSessions: 0,
  remoteDesktopMaxSessions: 0,
  message: null,
};

it("filters the local server when local hosting is disabled", () => {
  expect(withLocalHostSummary([localServer, remoteServer], status, false)).toEqual([{ ...remoteServer, active: true }]);
});

it("keeps and decorates the local server when local hosting is enabled", () => {
  expect(withLocalHostSummary([localServer, remoteServer], status, true)).toEqual([
    { ...localServer, name: "OpenBot host" },
    remoteServer,
  ]);
});

it("filters the local server even when a host status is not available", () => {
  expect(withLocalHostSummary([localServer, remoteServer], null, false)).toEqual([{ ...remoteServer, active: true }]);
});

it("keeps the selected remote server active when Local was the saved selection", () => {
  expect(withLocalHostSummary([localServer, remoteServer], status, false).find((server) => server.active)?.id).toBe(
    remoteServer.id,
  );
});
