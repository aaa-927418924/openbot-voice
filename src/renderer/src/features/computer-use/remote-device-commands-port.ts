import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

/** Remote-device settings and the separate same-account sharing control. */
export interface RemoteDeviceCommandsPort {
  deviceCommands: OpenBotDesktopApi["deviceCommands"];
}

/** Read on every call so tests and stories can replace the bridge. */
export function remoteDeviceCommandsPort(): RemoteDeviceCommandsPort {
  return {
    deviceCommands: window.openbot.deviceCommands,
  };
}
