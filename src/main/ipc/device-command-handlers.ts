import type { RemoteDeviceCommandClient } from "../remote-device-command-client";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import {
  decodeRemoteDeviceCommandTargetInput,
  decodeUpdateRemoteDeviceCommandTargetInput,
} from "./device-command-inputs";

export function deviceCommandIpcHandlers(
  client: Pick<RemoteDeviceCommandClient, "listTargets" | "getPermission" | "updatePermission">,
): Pick<IpcGroupHandlers, "deviceCommands"> {
  return {
    deviceCommands: {
      listTargets: handler(() => client.listTargets()),
      getPermission: payloadHandler(decodeRemoteDeviceCommandTargetInput, (input) => client.getPermission(input)),
      updatePermission: payloadHandler(decodeUpdateRemoteDeviceCommandTargetInput, (input) =>
        client.updatePermission(input),
      ),
    },
  };
}
