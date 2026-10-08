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
              text: expect.stringContaining("complete submitted text and every URL"),
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
      } else if (method === "thread/inject_items") {
        expect(params).toMatchObject({
          threadId: "thread-a",
          items: [{ type: "message", role: "user", content: [{ type: "input_text" }] }],
        });
      } else if (method === "thread/realtime/appendText") {
        expect(params).toMatchObject({ threadId: "thread-a", role: "user" });
      }
      return decoder({});
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

  it("injects the exact user text into the backing thread before appending it to Live Voice", async () => {
    const client = new FakeClient();
    const adapter = new CodexLiveVoiceAdapter({ client, onEvent: () => undefined });
    const text = "Summarize https://example.test/記事?q=live%20voice&lang=ja#要点";
    await Effect.runPromise(adapter.start("thread-a", "offer-sdp", "maple"));

    await expect(Effect.runPromise(adapter.injectUserText("thread-a", text))).resolves.toBeUndefined();
    await expect(Effect.runPromise(adapter.appendText("thread-a", text))).resolves.toBeUndefined();
    await expect(Effect.runPromise(adapter.injectUserText("thread-b", "ignored"))).rejects.toThrow();
    await expect(Effect.runPromise(adapter.appendText("thread-b", "ignored"))).rejects.toThrow();
    expect(client.requests.slice(1)).toEqual([
      {
        method: "thread/inject_items",
        params: {
          threadId: "thread-a",
          items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
        },
      },
      { method: "thread/realtime/appendText", params: { threadId: "thread-a", text, role: "user" } },
    ]);
    expect(client.requestCalls).toBe(3);

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
