import { Context, Effect, Layer, Schema } from "effect";
import { causeHelpers } from "../backend/effect-boundary";

export class CentralAuthOperationError extends Schema.TaggedError<CentralAuthOperationError>()(
  "CentralAuthOperationError",
  {
    cause: Schema.Defect(),
  },
) {}

export const { io: authCall, sync: authDecode } = causeHelpers(CentralAuthOperationError);

export class CentralAuthTransport extends Context.Service<
  CentralAuthTransport,
  {
    fetch(input: string | URL | Request, init?: RequestInit): Effect.Effect<Response, CentralAuthOperationError>;
  }
>()("openbot/main/CentralAuthTransport") {
  static layer(
    fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
    onFetchFailure?: (cause: unknown, input: string | URL | Request) => void,
  ) {
    return Layer.succeed(
      CentralAuthTransport,
      CentralAuthTransport.of({
        fetch: (input, init) =>
          Effect.tryPromise({
            try: (signal) =>
              fetcher(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }),
            catch: (cause) => {
              try {
                onFetchFailure?.(cause, input);
              } catch {
                // Diagnostic callbacks cannot change the request result.
              }
              return new CentralAuthOperationError({ cause });
            },
          }),
      }),
    );
  }
}
