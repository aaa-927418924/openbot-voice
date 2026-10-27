// @vitest-environment node

import { IPC_ENDPOINTS } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostedServerDesktopService } from "../hosted-server-service";
import { registerIpcGroup } from "./define-ipc-group";
import { hostedServerIpcHandlers } from "./hosted-server-handlers";

type Invoke = (event: unknown, ...arguments_: unknown[]) => unknown;
const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, Invoke>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: Invoke) {
      registrations.set(channel, listener);
    },
  },
}));

const TRUSTED_EVENT = { senderFrame: { url: "openbot-app://app/index.html" } };

function setup(localOnlyNetworking: boolean) {
  registrations.clear();
  const requests: string[] = [];
  const service = new HostedServerDesktopService(
    {
      requestAuthorized<T>(path: string, _init: RequestInit, decode: (value: unknown) => T) {
        requests.push(path);
        return Effect.succeed(decode({ available: true, servers: [], maxServers: null }));
      },
    },
    async () => {},
  );

  registerIpcGroup(
    "hostedServers",
    hostedServerIpcHandlers({ hostedServers: service, localOnlyNetworking }).hostedServers,
  );

  return {
    service,
    requests,
    invoke(channel: string, ...arguments_: unknown[]) {
      const listener = registrations.get(channel);
      if (!listener) throw new Error(`No handler registered for ${channel}.`);
      return listener(TRUSTED_EVENT, ...arguments_);
    },
  };
}

describe("hostedServerIpcHandlers", () => {
  beforeEach(() => registrations.clear());

  it("does not contact the account API for hosted servers in local-only mode", async () => {
    const { requests, invoke } = setup(true);

    await expect(Promise.resolve(invoke(IPC_ENDPOINTS.hostedServers.list.channel))).resolves.toEqual({
      available: false,
      servers: [],
      maxServers: null,
    });
    expect(requests).toEqual([]);
    await expect(Promise.resolve().then(() => invoke(IPC_ENDPOINTS.hostedServers.plans.channel))).rejects.toThrow(
      "Hosted servers are unavailable in local-only mode.",
    );
    expect(requests).toEqual([]);
  });

  it("keeps hosted-server listing connected to the account API in account mode", async () => {
    const { requests, invoke } = setup(false);

    await expect(Promise.resolve(invoke(IPC_ENDPOINTS.hostedServers.list.channel))).resolves.toEqual({
      available: true,
      servers: [],
      maxServers: null,
    });
    expect(requests).toEqual(["/v2/hosting/servers/"]);
  });
});
