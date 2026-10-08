import { Effect } from "effect";
// @vitest-environment node

import { IPC_ENDPOINTS } from "@openbot/contracts/ipc";
import {
  CLEAR_CONVERSATION_HISTORY_ROUTE,
  CONVERSATION_HISTORY_DELETE_CAPABILITY,
  DELETE_CONVERSATION_MESSAGE_ROUTE,
} from "@openbot/contracts/team-protocol/conversation-history-delete-v1";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResponseDecoder } from "../remote-host-decoding";
import { type RemoteHostRequestTransport, type RemoteRequestInit, RemoteServerClient } from "../remote-server-client";
import { RemoteServerConnections } from "../remote-server-connections";
import { storedHttpsServer } from "../remote-server-test-harness";
import type { AgentIpcDependencies } from "./agent-handlers";

type TrustedInvoke = (event: { senderFrame: { url: string } }, payload: unknown) => unknown;

const { bound } = vi.hoisted(() => ({ bound: new Map<string, TrustedInvoke>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, invoke: TrustedInvoke) => bound.set(channel, invoke) },
}));

const { agentIpcHandlers } = await import("./agent-handlers");

const TRUSTED_EVENT = { senderFrame: { url: "openbot-app://app/index.html" } };
const SERVER_ID = "remote-host";

afterEach(() => {
  bound.clear();
  vi.unstubAllGlobals();
});

function setup(transportKind: "https" | "webrtc") {
  const paths: string[] = [];
  const disconnect = vi.fn();
  const connections = new RemoteServerConnections({
    appVersion: null,
    onChanged: () => undefined,
    // The manager disconnects a WebRTC host from this callback when a response is classified as a
    // protocol error. Keep that observable here without opening a real peer connection.
    onReconnectSuspended: disconnect,
  });
  const server = storedHttpsServer(
    SERVER_ID,
    transportKind === "webrtc" ? { transport: "webrtc-v2", apiUrl: `webrtc://${SERVER_ID}` } : {},
  );
  let transport: RemoteHostRequestTransport | null = null;

  if (transportKind === "webrtc") {
    transport = {
      request: (_hostId, path) =>
        Effect.sync(() => {
          paths.push(path);
          const codec = teamSideRouteCodec(path);
          if (!codec) throw new Error(`No side-route codec for ${path}.`);
          return codec.response(path, 200, {});
        }),
      requestResponse: () =>
        Effect.sync(() => {
          throw new Error("Unexpected binary request.");
        }),
    };
  } else {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        paths.push(new URL(url).pathname);
        return Response.json({});
      }),
    );
  }

  const client = new RemoteServerClient({
    appVersion: null,
    servers: { require: () => server, token: () => "test-token" },
    connections,
    transport,
  });
  const remoteServers: Pick<AgentIpcDependencies["remoteServers"], "request" | "supportsCapability"> = {
    supportsCapability: (_serverId, capability) => capability === CONVERSATION_HISTORY_DELETE_CAPABILITY,
    request: <T>(serverId: string, path: string, decoder: ResponseDecoder<T>, init?: RemoteRequestInit) =>
      client.request(serverId, path, decoder, init),
  };
  const dependencies = {
    service: {},
    sidebarLayout: {},
    host: {},
    remoteServers,
    skills: {},
  };
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: Only the remote deletion branches are called; the other service surfaces stay unused.
  const handlers = agentIpcHandlers(dependencies as unknown as AgentIpcDependencies).agent;

  handlers.deleteConversationMessage(IPC_ENDPOINTS.agent.deleteConversationMessage.channel);
  handlers.clearConversationHistory(IPC_ENDPOINTS.agent.clearConversationHistory.channel);

  const invoke = async (channel: string, payload: unknown) => {
    const listener = bound.get(channel);
    if (!listener) throw new Error(`No IPC handler registered for ${channel}.`);
    return await listener(TRUSTED_EVENT, payload);
  };

  return { connections, disconnect, invoke, paths };
}

describe.each(["https", "webrtc"] as const)("remote conversation deletion over %s", (transportKind) => {
  it("accepts both validated empty-object replies without suspending the host connection", async () => {
    const fixture = setup(transportKind);

    await expect(
      fixture.invoke(IPC_ENDPOINTS.agent.deleteConversationMessage.channel, {
        serverId: SERVER_ID,
        payload: { agentId: "agent-1", messageId: "message-1" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      fixture.invoke(IPC_ENDPOINTS.agent.clearConversationHistory.channel, {
        serverId: SERVER_ID,
        payload: "agent-1",
      }),
    ).resolves.toBeUndefined();

    expect(fixture.paths).toEqual([DELETE_CONVERSATION_MESSAGE_ROUTE, CLEAR_CONVERSATION_HISTORY_ROUTE]);
    expect(fixture.connections.issueFor(SERVER_ID)).toBeNull();
    expect(fixture.disconnect).not.toHaveBeenCalled();
  });
});
