import type { ServerSummary } from "@openbot/contracts/ipc";

type IslandServer = Pick<ServerSummary, "id" | "kind" | "state" | "notificationsMuted">;

/** Keep the legacy local placeholder only while the account server list is still loading. */
export function dynamicIslandServerOrder(
  servers: readonly IslandServer[],
  connectedServerIds: ReadonlySet<string>,
  activeServerId: string,
  serverListReady: boolean,
): string[] {
  const ordered = servers
    .filter((server) => connectedServerIds.has(server.id) && (server.kind === "local" || server.state === "online"))
    .map((server) => server.id);
  ordered.sort((left, right) => Number(right === activeServerId) - Number(left === activeServerId));
  const result = ordered.length > 0 ? ordered : serverListReady ? [] : ["local"];
  const muted = new Set(servers.filter((server) => server.notificationsMuted).map((server) => server.id));
  return result.filter((serverId) => !muted.has(serverId));
}

/** Unknown scoped events are accepted only for the provisional local scope before initial load. */
export function canApplyDynamicIslandServerEvent(
  serverId: string,
  servers: readonly Pick<ServerSummary, "id">[],
  serverListReady: boolean,
): boolean {
  return servers.some((server) => server.id === serverId) || (!serverListReady && serverId === "local");
}
