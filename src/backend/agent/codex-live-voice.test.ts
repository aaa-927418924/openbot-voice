import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentClient, RequestTimeoutError } from "../agent-client";
import { AppServerError } from "../app-server-client";
import type { ResponseDecoder } from "../protocol";
import { ProviderClientOperationError } from "../provider-client-effects";
import { CodexLiveVoiceAdapter, type CodexRealtimeEvent } from "./codex-live-voice";

class FakeClient extends EventEmitter implements AgentClient {
  readonly provider = "codex" as const;
  readonly running = true;
  start(): void {}
  requestCalls = 0;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  startFailure: ProviderClientOperationError | undefined;
  request<T>(
    method: string,
    params: unknown,
    decoder: ResponseDecoder<T>,
    _timeoutMs?: number,
  ): Effect.Effect<T, ProviderClientOperationError> {
    this.requestCalls++;
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "thread/realtime/start" && this.startFailure) return Effect.fail(this.startFailure);
    return Effect.sync(() => {
      if (method === "thread/realtime/start") {
        expect(params).toMatchObject({
          outputModality: "audio",
          model: "gpt-live-1-codex",
          version: "v3",
          voice: "maple",
          initialItems: [
            {
              role: "developer",
              text: expect.stringContaining("sent directly as a user turn to this same Codex thread"),
            },
          ],
          realtimeStartInstructions: expect.stringContaining("available Codex tools"),
          transport: { type: "webrtc", sdp: "offer-sdp" },
        });
        this.emit("notification", {
          method: "thread/realtime/started",
          params: { threadId: "thread-a", realtimeSessionId: "realtime-a" },
        });
        this.emit("notification", {
          method: "thread/realtime/sdp",
          params: { threadId: "thread-a", sdp: "answer-sdp" },
        });
      }
      return decoder(method === "turn/start" ? { turn: { id: "turn-a", status: "inProgress" } } : {});
    });
  }
  readonly notify = vi.fn();
  readonly respond = vi.fn();
  readonly respondError = vi.fn();
  readonly stop = vi.fn(() => Effect.void);
}

describe("CodexLiveVoiceAdapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts an early SDP notification and deduplicates finalized realtime items by canonical id", async () => {
    const client = new FakeClient();
    const events: CodexRealtimeEvent[] = [];
    const adapter = new CodexLiveVoiceAdapter({ client, onEvent: (event) => events.push(event) });

    await expect(Effect.runPromise(adapter.start("thread-a", "offer-sdp", "maple"))).resolves.toEqual({
      threadId: "thread-a",
      sdp: "answer-sdp",
    });
    const item = {
      id: "item-a",
      realtimeSessionId: "realtime-a",
      type: "transcriptSegment",
      role: "user",
      text: "hello",
    };
    client.emit("notification", { method: "thread/realtime/item/completed", params: { threadId: "thread-a", item } });
    client.emit("notification", { method: "thread/realtime/item/completed", params: { threadId: "thread-a", item } });

    expect(events.filter((event) => event.type === "item")).toEqual([{ type: "item", threadId: "thread-a", item }]);
    expect(client.requestCalls).toBe(1);
    client.emit("notification", { method: "thread/realtime/closed", params: { threadId: "thread-a" } });
    await Effect.runPromise(adapter.stop("thread-a"));
  });

  it("keeps the provider thread active until the official closed notification arrives", async () => {
    const client = new FakeClient();
    const adapter = new CodexLiveVoiceAdapter({ client, onEvent: () => undefined });
    await Effect.runPromise(adapter.start("thread-a", "offer-sdp", "maple"));

    let stopped = false;
    const stopping = Effect.runPromise(adapter.stop("thread-a")).then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(client.requestCalls).toBe(2));
    expect(adapter.isActive("thread-a")).toBe(true);
    expect(stopped).toBe(false);

    client.emit("notification", { method: "thread/realtime/closed", params: { threadId: "thread-a" } });
    expect(adapter.isActive("thread-a")).toBe(false);
    await stopping;
    expect(adapter.isActive("thread-a")).toBe(false);
    expect(stopped).toBe(true);
  });

  it("does not dispatch a transcript-tail task when Live Voice stops", async () => {
    const client = new FakeClient();
    const adapter = new CodexLiveVoiceAdapter({ client, onEvent: () => undefined });
    await Effect.runPromise(adapter.start("thread-a", "offer-sdp", "maple"));

    const startRequest = client.requests.find((request) => request.method === "thread/realtime/start");
    expect(startRequest?.params).toMatchObject({
      flushTranscriptTailOnSessionEnd: false,
      realtimeEndInstructions: expect.stringContaining("Continue any delegated work already running"),
    });
    expect(startRequest?.params).toMatchObject({
      realtimeEndInstructions: expect.stringContaining("Do not re-review or repeat completed work"),
    });
    expect(startRequest?.params).toMatchObject({
      realtimeEndInstructions: expect.stringContaining("closing recap just because the session ended"),
    });
    expect(startRequest?.params).not.toMatchObject({
      realtimeEndInstructions: expect.stringContaining("transcript tail"),
    });

    const stopping = Effect.runPromise(adapter.stop("thread-a"));
    await vi.waitFor(() => expect(client.requests.map((request) => request.method)).toContain("thread/realtime/stop"));
    client.emit("notification", { method: "thread/realtime/closed", params: { threadId: "thread-a" } });
    await stopping;

    expect(client.requests.map((request) => request.method)).toEqual(["thread/realtime/start", "thread/realtime/stop"]);
  });

  it("starts one user turn with exact text and the existing provider-thread settings", async () => {
    const client = new FakeClient();
    const adapter = new CodexLiveVoiceAdapter({ client, onEvent: () => undefined });
    const text = "Summarize https://example.test/記事?q=live%20voice&lang=ja#要点";
    await Effect.runPromise(adapter.start("thread-a", "offer-sdp", "maple"));

    await expect(
      Effect.runPromise(
        adapter.startOrSteerUserTurn("thread-a", {
          clientUserMessageId: "livevoice-0123456789abcdef0123456789abcdef0123456789abcdef",
          text,
          model: "gpt-6-luna",
          effort: "medium",
          cwd: "/tmp/openbot-live",
          runtimeWorkspaceRoots: ["/tmp/openbot-live", "/tmp/openbot-shared"],
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/tmp/openbot-live", "/tmp/openbot-shared"],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          additionalContext: {
            openbot_live_voice_spoken_context: { kind: "untrusted", value: "[]" },
            openbot_live_voice_typed_dispatch: { kind: "application", value: "Perform the typed request." },
          },
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(
        adapter.startOrSteerUserTurn("thread-b", {
          clientUserMessageId: "livevoice-0123456789abcdef0123456789abcdef0123456789abcdef",
          text,
          model: "gpt-6-luna",
          effort: "medium",
          cwd: "/tmp/openbot-live",
          runtimeWorkspaceRoots: [],
          sandboxPolicy: { type: "dangerFullAccess" },
          additionalContext: {},
        }),
      ),
    ).rejects.toThrow();
    expect(client.requests.slice(1)).toEqual([
      {
        method: "turn/start",
        params: {
          threadId: "thread-a",
          model: "gpt-6-luna",
          effort: "medium",
          clientUserMessageId: "livevoice-0123456789abcdef0123456789abcdef0123456789abcdef",
          input: [{ type: "text", text }],
          cwd: "/tmp/openbot-live",
          runtimeWorkspaceRoots: ["/tmp/openbot-live", "/tmp/openbot-shared"],
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/tmp/openbot-live", "/tmp/openbot-shared"],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          additionalContext: {
            openbot_live_voice_spoken_context: { kind: "untrusted", value: "[]" },
            openbot_live_voice_typed_dispatch: { kind: "application", value: "Perform the typed request." },
          },
        },
      },
    ]);
    expect(client.requestCalls).toBe(2);
    expect(client.requests.map((request) => request.method)).not.toContain("thread/inject_items");
    expect(client.requests.map((request) => request.method)).not.toContain("thread/realtime/appendText");

    client.emit("notification", { method: "thread/realtime/closed", params: { threadId: "thread-a" } });
    await Effect.runPromise(adapter.stop("thread-a"));
  });

  it("cleans up a definitive JSON-RPC start rejection and permits a later attempt", async () => {
    const client = new FakeClient();
    const events: CodexRealtimeEvent[] = [];
    const adapter = new CodexLiveVoiceAdapter({ client, onEvent: (event) => events.push(event) });
    client.startFailure = new ProviderClientOperationError({ cause: new AppServerError("unsupported method", -32601) });

    await expect(Effect.runPromise(adapter.start("thread-a", "offer-sdp", "maple"))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "unsupported method", code: -32601 }),
    });
    expect(adapter.isActive("thread-a")).toBe(false);
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1);

    client.startFailure = undefined;
    await expect(Effect.runPromise(adapter.start("thread-a", "offer-sdp", "maple"))).resolves.toMatchObject({
      sdp: "answer-sdp",
    });
    client.emit("notification", { method: "thread/realtime/closed", params: { threadId: "thread-a" } });
  });

  it("retains an ambiguous timed-out start until the official close notification arrives", async () => {
    const client = new FakeClient();
    const events: CodexRealtimeEvent[] = [];
    const adapter = new CodexLiveVoiceAdapter({ client, onEvent: (event) => events.push(event) });
    client.startFailure = new ProviderClientOperationError({
      cause: new RequestTimeoutError("Codex", "thread/realtime/start"),
    });

    await expect(Effect.runPromise(adapter.start("thread-a", "offer-sdp", "maple"))).rejects.toMatchObject({
      cause: expect.objectContaining({ method: "thread/realtime/start" }),
    });
    expect(adapter.isActive("thread-a")).toBe(true);
    expect(events.some((event) => event.type === "closed")).toBe(false);

    client.emit("notification", { method: "thread/realtime/closed", params: { threadId: "thread-a" } });
    expect(adapter.isActive("thread-a")).toBe(false);
  });
});
