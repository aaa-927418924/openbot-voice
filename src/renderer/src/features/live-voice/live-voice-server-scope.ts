import type { ServerSummary } from "@openbot/contracts/ipc";
import type { LiveVoiceState } from "./live-voice-controller";

/** Stop media and host state when its server was removed from the signed-in account. */
export function shouldStopLiveVoiceForMissingServer(
  serverId: string | undefined,
  servers: readonly Pick<ServerSummary, "id">[],
  serverListReady: boolean,
  state: LiveVoiceState,
): boolean {
  if (!serverListReady || !serverId || servers.some((server) => server.id === serverId)) return false;
  return (
    state.phase !== "stopping" && (state.hostSessionActive || state.phase === "connecting" || state.phase === "live")
  );
}
