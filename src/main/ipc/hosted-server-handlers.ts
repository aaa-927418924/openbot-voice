// OpenBot servers that the account server runs for the signed-in account.

import {
  type CreateHostedServerInput,
  type DeleteHostedServerInput,
  type HostedServerList,
  parseCreateHostedServerInput,
  parseDeleteHostedServerInput,
} from "@openbot/contracts/hosted-servers";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { HostedServerDesktopService } from "../hosted-server-service";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { requireString } from "./validation";

export interface HostedServerIpcDependencies {
  hostedServers: HostedServerDesktopService;
  localOnlyNetworking?: boolean;
}

export function hostedServerIpcHandlers({
  hostedServers,
  localOnlyNetworking = false,
}: HostedServerIpcDependencies): Pick<IpcGroupHandlers, "hostedServers"> {
  const unavailable = () => {
    if (localOnlyNetworking) throw new Error("Hosted servers are unavailable in local-only mode.");
  };

  return {
    hostedServers: {
      list: handler(() => (localOnlyNetworking ? LOCAL_ONLY_HOSTED_SERVER_LIST : runCauseEffect(hostedServers.list()))),
      plans: handler(() => {
        unavailable();
        return runCauseEffect(hostedServers.plans());
      }),
      create: payloadHandler(parseCreate, (input) => {
        unavailable();
        return runCauseEffect(hostedServers.create(input));
      }),
      openCheckout: payloadHandler(
        (value) => requireString(value, "serverId", INPUT_LIMITS.identifier),
        (serverId) => {
          unavailable();
          return runCauseEffect(hostedServers.openCheckout(serverId));
        },
      ),
      delete: payloadHandler(parseDelete, (input) => {
        unavailable();
        return runCauseEffect(hostedServers.delete(input));
      }),
      wake: payloadHandler(
        (value) => requireString(value, "serverId", INPUT_LIMITS.identifier),
        (serverId) => {
          unavailable();
          return runCauseEffect(hostedServers.wake(serverId));
        },
      ),
    },
  };
}

const LOCAL_ONLY_HOSTED_SERVER_LIST: HostedServerList = {
  available: false,
  servers: [],
  maxServers: null,
};

function parseCreate(value: unknown): CreateHostedServerInput {
  const input = parseCreateHostedServerInput(value);
  if (!input) throw new Error("Invalid hosted server.");
  return input;
}

function parseDelete(value: unknown): DeleteHostedServerInput {
  const input = parseDeleteHostedServerInput(value);
  if (!input) throw new Error("Invalid hosted server deletion.");
  return input;
}
