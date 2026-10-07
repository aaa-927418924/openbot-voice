// @vitest-environment node

import { isLiveVoiceStartOutcome, type LiveVoiceStartOutcome } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { LiveVoiceIpcDependencies } from "./live-voice-handlers";

type TrustedInvoke = (event: { senderFrame: { url: string }; sender?: { id: number } }, payload: unknown) => unknown;

const bound = vi.hoisted(() => new Map<string, TrustedInvoke>());
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, listener: TrustedInvoke) => bound.set(channel, listener) },
}));

const { IPC_ENDPOINTS, LOCAL_SERVER_ID } = await import("@openbot/contracts/ipc");
const { LIVE_VOICE_CAPABILITY, LIVE_VOICE_ROUTES, LiveVoiceRefusedError } = await import(
  "@openbot/contracts/team-protocol/live-voice-v1"
);
const { RemoteRequestError } = await import("../remote-server-errors");
const { RemoteWorkflowError } = await import("../remote-service-effects");
const { liveVoiceIpcHandlers, requireLiveVoiceWindowSender } = await import("./live-voice-handlers");

const MAIN_FRAME = { sender: { id: 41 }, senderFrame: { url: "openbot-app://app/index.html" } };
const START_INPUT = {
  agentId: "agent-1",
  threadId: "thread-1",
  clientSessionId: "00000000-0000-4000-8000-000000000001",
  sdpOffer: "offer",
};
const START_RESULT = {
  sessionId: "00000000-0000-4000-8000-000000000002",
  sdpAnswer: "answer",
};
const START_OUTCOME = { kind: "started", ...START_RESULT } satisfies LiveVoiceStartOutcome;
const STOP_INPUT = {
  agentId: "agent-1",
  threadId: "thread-1",
  sessionId: START_RESULT.sessionId,
};

function bind(remoteSupportsLiveVoice = true, remoteStartFailure?: Error, localStartFailure?: Error) {
  bound.clear();
  const local = {
    startLiveVoice: vi.fn(() =>
      localStartFailure
        ? Effect.sync(() => {
            throw localStartFailure;
          })
        : Effect.succeed(START_RESULT),
    ),
    stopLiveVoice: vi.fn(() => Effect.void),
    sendLiveVoiceText: vi.fn(() => Effect.void),
  };
  const requests: Array<{ serverId: string; path: string; body: unknown; timeoutMs?: number }> = [];
  const requestRemote: LiveVoiceIpcDependencies["remoteServers"]["request"] = <T>(
    serverId: string,
    path: string,
    decode: (value: unknown) => T,
    init?: { body?: unknown; timeoutMs?: number },
  ) => {
    requests.push({ serverId, path, body: init?.body, timeoutMs: init?.timeoutMs });
    if (path === LIVE_VOICE_ROUTES.start && remoteStartFailure)
      return Effect.fail(new RemoteWorkflowError({ cause: remoteStartFailure }));
    return Effect.succeed(decode(path === LIVE_VOICE_ROUTES.start ? START_RESULT : undefined));
  };
  const remoteServers = {
    supportsCapability: vi.fn(
      (_serverId: string, capability: string) => capability === LIVE_VOICE_CAPABILITY && remoteSupportsLiveVoice,
    ),
    request: requestRemote,
  };
  const handlers = liveVoiceIpcHandlers({
    service: local,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { id: MAIN_FRAME.sender.id } }),
    remoteServers,
  });
  handlers.liveVoice.start(IPC_ENDPOINTS.liveVoice.start.channel);
  handlers.liveVoice.stop(IPC_ENDPOINTS.liveVoice.stop.channel);
  handlers.liveVoice.sendText(IPC_ENDPOINTS.liveVoice.sendText.channel);
  return { local, remoteServers, requests };
}

function invoke(channel: string, payload: unknown): Promise<LiveVoiceStartOutcome | undefined> {
  const listener = bound.get(channel);
  if (!listener) throw new Error(`No IPC listener registered for ${channel}`);
  return Promise.resolve(listener(MAIN_FRAME, payload)).then((value) => {
    if (value === undefined) return undefined;
    if (!isLiveVoiceStartOutcome(value)) throw new Error("Invalid Live voice IPC result.");
    return value;
  });
}

describe("Live voice IPC routing", () => {
  it("routes start, stop, and text to the session's remote host", async () => {
    const { local, remoteServers, requests } = bind();

    await expect(
      invoke(IPC_ENDPOINTS.liveVoice.start.channel, { serverId: "remote-1", payload: START_INPUT }),
    ).resolves.toEqual(START_OUTCOME);
    await expect(
      invoke(IPC_ENDPOINTS.liveVoice.stop.channel, { serverId: "remote-1", payload: STOP_INPUT }),
    ).resolves.toBeUndefined();
    await expect(
      invoke(IPC_ENDPOINTS.liveVoice.sendText.channel, {
        serverId: "remote-1",
        payload: { ...STOP_INPUT, text: "調査して https://example.com" },
      }),
    ).resolves.toBeUndefined();

    expect(local.startLiveVoice).not.toHaveBeenCalled();
    expect(local.stopLiveVoice).not.toHaveBeenCalled();
    expect(local.sendLiveVoiceText).not.toHaveBeenCalled();
    expect(remoteServers.supportsCapability).toHaveBeenCalledWith("remote-1", LIVE_VOICE_CAPABILITY);
    expect(requests).toEqual([
      {
        serverId: "remote-1",
        path: LIVE_VOICE_ROUTES.start,
        body: START_INPUT,
        timeoutMs: 60_000,
      },
      { serverId: "remote-1", path: LIVE_VOICE_ROUTES.stop, body: STOP_INPUT, timeoutMs: undefined },
      {
        serverId: "remote-1",
        path: LIVE_VOICE_ROUTES.sendText,
        body: { ...STOP_INPUT, text: "調査して https://example.com" },
        timeoutMs: undefined,
      },
    ]);
  });

  it("keeps local sessions on the local agent", async () => {
    const localSetup = bind();
    await expect(
      invoke(IPC_ENDPOINTS.liveVoice.start.channel, { serverId: LOCAL_SERVER_ID, payload: START_INPUT }),
    ).resolves.toEqual(START_OUTCOME);
    expect(localSetup.local.startLiveVoice).toHaveBeenCalledWith(START_INPUT);
    expect(localSetup.requests).toEqual([]);
  });

  it("returns a definitive remote refusal as a result while preserving the host message", async () => {
    const { requests } = bind(true, new RemoteRequestError(409, "Codex account is required."));

    await expect(
      invoke(IPC_ENDPOINTS.liveVoice.start.channel, { serverId: "remote-1", payload: START_INPUT }),
    ).resolves.toEqual({ kind: "refused", message: "Codex account is required." });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe(LIVE_VOICE_ROUTES.start);
  });

  it.each([400, 404])("maps remote HTTP %i start responses to definitive refusals", async (status) => {
    const message = status === 400 ? "Live voice is unsupported." : "The selected agent no longer exists.";
    const { requests } = bind(true, new RemoteRequestError(status, message));

    await expect(
      invoke(IPC_ENDPOINTS.liveVoice.start.channel, { serverId: "remote-1", payload: START_INPUT }),
    ).resolves.toEqual({ kind: "refused", message });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe(LIVE_VOICE_ROUTES.start);
  });

  it("keeps remote server failures ambiguous", async () => {
    const { requests } = bind(true, new RemoteRequestError(500, "Host service failed."));

    await expect(
      invoke(IPC_ENDPOINTS.liveVoice.start.channel, { serverId: "remote-1", payload: START_INPUT }),
    ).rejects.toThrow("Host service failed.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe(LIVE_VOICE_ROUTES.start);
  });

  it("returns unsupported capability as a definitive refusal without requesting the host route", async () => {
    const { remoteServers, requests } = bind(false);

    await expect(
      invoke(IPC_ENDPOINTS.liveVoice.start.channel, { serverId: "old-host", payload: START_INPUT }),
    ).resolves.toMatchObject({ kind: "refused", message: expect.any(String) });
    expect(remoteServers.supportsCapability).toHaveBeenCalledWith("old-host", LIVE_VOICE_CAPABILITY);
    expect(requests).toEqual([]);
  });

  it("maps a local Live voice refusal to the definitive refusal outcome", async () => {
    const { local, requests } = bind(true, undefined, new LiveVoiceRefusedError("Codex account is required."));

    await expect(
      invoke(IPC_ENDPOINTS.liveVoice.start.channel, { serverId: LOCAL_SERVER_ID, payload: START_INPUT }),
    ).resolves.toEqual({ kind: "refused", message: "Codex account is required." });
    expect(local.startLiveVoice).toHaveBeenCalledWith(START_INPUT);
    expect(requests).toEqual([]);
  });

  it("accepts only the current main window as the sender", () => {
    let destroyed = false;
    const window = { isDestroyed: () => destroyed, webContents: { id: MAIN_FRAME.sender.id } };

    expect(() => requireLiveVoiceWindowSender(41, window)).not.toThrow();
    expect(() => requireLiveVoiceWindowSender(42, window)).toThrow();
    destroyed = true;
    expect(() => requireLiveVoiceWindowSender(41, window)).toThrow();
    expect(() => requireLiveVoiceWindowSender(41, null)).toThrow();
  });
});
