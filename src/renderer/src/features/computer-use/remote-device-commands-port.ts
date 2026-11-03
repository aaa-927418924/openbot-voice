import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

/** The remote-device settings and the agent list used to scope grants to this coordinator. */
export interface RemoteDeviceCommandsPort {
  deviceCommands: OpenBotDesktopApi["deviceCommands"];
  listAgents: OpenBotDesktopApi["agent"]["listAgents"];
}

/** Read on every call so tests and stories can replace the bridge. */
export function remoteDeviceCommandsPort(): RemoteDeviceCommandsPort {
  return {
    deviceCommands: window.openbot.deviceCommands,
    listAgents: window.openbot.agent.listAgents,
  };
}
