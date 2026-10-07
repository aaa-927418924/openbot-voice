import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Deferred, Effect, Exit } from "effect";
import type { AgentClient } from "../agent-client";
import { AppServerError } from "../app-server-client";
import { decodeRecordResponse } from "../protocol";
import { ProviderClientOperationError, providerFailure } from "../provider-client-effects";

const SDP_LIMIT = 256_000;
const ANSWER_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 15_000;

export interface CodexRealtimeAnswer {
  readonly threadId: string;
  readonly sdp: string;
}

export interface CodexTranscriptSegment {
  readonly id: string;
  readonly realtimeSessionId: string;
  readonly type: "transcriptSegment";
  readonly role: "user" | "assistant";
  readonly text: string;
}

export type CodexRealtimeEvent =
  | { readonly type: "closed"; readonly threadId: string; readonly reason?: string }
  | { readonly type: "error"; readonly threadId: string; readonly message: string }
  | { readonly type: "item"; readonly threadId: string; readonly item: CodexTranscriptSegment };

interface SignalState {
  readonly answer: Deferred.Deferred<CodexRealtimeAnswer | null>;
  readonly closed: Deferred.Deferred<boolean>;
  readonly seenItems: Set<string>;
  realtimeSessionId?: string;
  answerReceived: boolean;
  listener?: (notification: { method: string; params: unknown }) => void;
  exitListener?: (error: Error) => void;
  stopped: boolean;
}

/** Translates the tagged Codex app-server realtime notifications for one thread. */
export class CodexLiveVoiceAdapter {
  readonly #client: AgentClient;
  readonly #onEvent: (event: CodexRealtimeEvent) => void;
  readonly #sessions = new Map<string, SignalState>();

  constructor(options: { client: AgentClient; onEvent: (event: CodexRealtimeEvent) => void }) {
    this.#client = options.client;
    this.#onEvent = options.onEvent;
  }

  readonly start = Effect.fn("CodexLiveVoiceAdapter.start")(function* (
    this: CodexLiveVoiceAdapter,
    threadId: string,
    offer: string,
  ) {
    if (this.#client.provider !== "codex" || !this.#client.running) throw new Error("Codex Live is unavailable.");
    if (!threadId || !offer || offer.length > SDP_LIMIT) throw new Error("Invalid realtime offer.");
    if (this.#sessions.has(threadId)) throw new Error("A realtime session is already active.");

    const session: SignalState = {
      answer: Deferred.makeUnsafe<CodexRealtimeAnswer | null>(),
      closed: Deferred.makeUnsafe<boolean>(),
      seenItems: new Set(),
      answerReceived: false,
      stopped: false,
    };
    this.#sessions.set(threadId, session);
    const cleanup = () => {
      if (session.listener) this.#client.off("notification", session.listener);
      if (session.exitListener) this.#client.off("exit", session.exitListener);
      if (this.#sessions.get(threadId) === session) this.#sessions.delete(threadId);
    };
    const listener = (notification: { method: string; params: unknown }) => {
      const params = notification.params;
      if (!isDynamicRecord(params) || params.threadId !== threadId || this.#sessions.get(threadId) !== session) return;
      if (
        session.realtimeSessionId &&
        isString(params.realtimeSessionId) &&
        params.realtimeSessionId !== session.realtimeSessionId
      )
        return;
      switch (notification.method) {
        case "thread/realtime/sdp":
          if (!session.answerReceived && isString(params.sdp) && params.sdp.length <= SDP_LIMIT) {
            session.answerReceived = true;
            Deferred.doneUnsafe(session.answer, Effect.succeed({ threadId, sdp: params.sdp }));
          }
          break;
        case "thread/realtime/started":
          if (isString(params.realtimeSessionId)) session.realtimeSessionId = params.realtimeSessionId;
          break;
        case "thread/realtime/closed":
          Deferred.doneUnsafe(session.closed, Effect.succeed(true));
          Deferred.doneUnsafe(session.answer, Effect.succeed(null));
          session.stopped = true;
          cleanup();
          this.#onEvent({ type: "closed", threadId, ...(isString(params.reason) ? { reason: params.reason } : {}) });
          break;
        case "thread/realtime/error":
          Deferred.doneUnsafe(session.answer, Effect.succeed(null));
          this.#onEvent({
            type: "error",
            threadId,
            message: isString(params.message) ? params.message : "Codex Live failed.",
          });
          break;
        case "thread/realtime/item/completed": {
          if (!isDynamicRecord(params.item) || !isString(params.item.id) || session.seenItems.has(params.item.id))
            break;
          if (!session.realtimeSessionId || params.item.realtimeSessionId !== session.realtimeSessionId) break;
          if (
            params.item.type === "transcriptSegment" &&
            isString(params.item.realtimeSessionId) &&
            (params.item.role === "user" || params.item.role === "assistant") &&
            isString(params.item.text)
          ) {
            const item: CodexTranscriptSegment = {
              id: params.item.id,
              realtimeSessionId: params.item.realtimeSessionId,
              type: "transcriptSegment",
              role: params.item.role,
              text: params.item.text,
            };
            session.seenItems.add(item.id);
            if (session.seenItems.size > 2048) {
              const oldest = session.seenItems.values().next();
              if (!oldest.done) session.seenItems.delete(oldest.value);
            }
            this.#onEvent({ type: "item", threadId, item });
          }
          break;
        }
      }
    };
    session.listener = listener;
    session.exitListener = () => {
      session.stopped = true;
      Deferred.doneUnsafe(session.closed, Effect.succeed(true));
      Deferred.doneUnsafe(session.answer, Effect.succeed(null));
      cleanup();
      this.#onEvent({ type: "closed", threadId, reason: "Codex provider exited." });
    };

    // Register first because the server can answer the offer before the start RPC response arrives.
    this.#client.on("notification", listener);
    this.#client.once("exit", session.exitListener);
    const connect = Effect.gen({ self: this }, function* () {
      yield* this.#client.request(
        "thread/realtime/start",
        {
          threadId,
          outputModality: "audio",
          model: "gpt-live-1-codex",
          version: "v3",
          transport: { type: "webrtc", sdp: offer },
        },
        decodeRecordResponse,
        START_TIMEOUT_MS,
      );
      const signal = yield* Deferred.await(session.answer).pipe(
        Effect.timeoutOrElse({ duration: ANSWER_TIMEOUT_MS, orElse: () => Effect.succeed(null) }),
      );
      if (!signal) return yield* Effect.fail(new Error("Codex Live did not return an SDP answer."));
      if (session.stopped) return yield* Effect.fail(new Error("Codex Live was stopped while connecting."));
      return signal;
    });
    return yield* connect.pipe(
      Effect.catch((error) => {
        // A JSON-RPC error is a definitive rejection: this request did not create a remote call.
        // Timeouts and transport failures are ambiguous, so the service keeps the lease and asks
        // the provider to stop while waiting for the only authoritative close notification.
        if (!(error instanceof ProviderClientOperationError && error.cause instanceof AppServerError))
          return Effect.fail(providerFailure(error));
        return Effect.sync(() => {
          if (this.#sessions.get(threadId) !== session) return;
          session.stopped = true;
          Deferred.doneUnsafe(session.closed, Effect.succeed(true));
          cleanup();
          this.#onEvent({ type: "closed", threadId, reason: "Codex rejected the realtime start." });
        }).pipe(Effect.andThen(Effect.fail(providerFailure(error))));
      }),
    );
  }).bind(this);

  readonly stop = Effect.fn("CodexLiveVoiceAdapter.stop")(function* (this: CodexLiveVoiceAdapter, threadId: string) {
    const session = this.#sessions.get(threadId);
    if (!session) return;
    if (session.stopped) throw new Error("A Codex Live stop request is already in progress.");
    session.stopped = true;
    Deferred.doneUnsafe(session.answer, Effect.succeed(null));
    yield* this.#client.request("thread/realtime/stop", { threadId }, decodeRecordResponse, START_TIMEOUT_MS).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) session.stopped = false;
        }),
      ),
    );
    const closed = yield* Deferred.await(session.closed).pipe(
      Effect.timeoutOrElse({ duration: ANSWER_TIMEOUT_MS, orElse: () => Effect.succeed(false) }),
    );
    if (!closed) {
      session.stopped = false;
      throw new Error("Codex Live did not confirm that its realtime session closed.");
    }
  }, Effect.uninterruptible).bind(this);

  readonly appendText = Effect.fn("CodexLiveVoiceAdapter.appendText")(function* (
    this: CodexLiveVoiceAdapter,
    threadId: string,
    text: string,
  ) {
    const session = this.#sessions.get(threadId);
    if (!session || session.stopped || !this.#client.running) throw new Error("Codex Live is unavailable.");
    yield* this.#client.request(
      "thread/realtime/appendText",
      { threadId, text, role: "user" },
      decodeRecordResponse,
      START_TIMEOUT_MS,
    );
  }).bind(this);

  readonly dispose = Effect.fn("CodexLiveVoiceAdapter.dispose")(function* (this: CodexLiveVoiceAdapter) {
    for (const threadId of [...this.#sessions.keys()]) yield* this.stop(threadId).pipe(Effect.ignore);
  }, Effect.uninterruptible).bind(this);

  isActive(threadId: string): boolean {
    return this.#sessions.has(threadId);
  }
}
