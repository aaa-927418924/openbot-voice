import { open } from "node:fs/promises";
import { Effect } from "effect";
import { runCauseEffect } from "../backend/effect-boundary";
import { RemoteWorkflowError, remoteCall } from "./remote-service-effects";

const CHUNK_BYTES = 64 * 1_024;

export interface ByteRange {
  start: number;
  end: number;
}

/** Parse the single byte range requested by media elements. Multiple ranges are unnecessary here. */
export function parseByteRange(header: string | null, size: number): ByteRange | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || size <= 0) return "invalid";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** Applies the same range contract when a remote attachment has already been fetched into memory. */
export function byteRangeResponse(
  bytes: Uint8Array,
  headers: Record<string, string>,
  rangeHeader: string | null,
): Response {
  const range = parseByteRange(rangeHeader, bytes.byteLength);
  const responseHeaders = { ...headers, "Accept-Ranges": "bytes" };
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${bytes.byteLength}` },
    });
  }
  if (!range) {
    return new Response(copyArrayBuffer(bytes), {
      headers: { ...responseHeaders, "Content-Length": String(bytes.byteLength) },
    });
  }
  const slice = bytes.slice(range.start, range.end + 1);
  return new Response(copyArrayBuffer(slice), {
    status: 206,
    headers: {
      ...responseHeaders,
      "Content-Length": String(slice.byteLength),
      "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
    },
  });
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** Streams a file without keeping its whole contents in memory. Open failures still let the caller answer 404. */
export const fileResponse = Effect.fn("FileResponse.open")(function* (
  path: string,
  headers: Record<string, string>,
  rangeHeader: string | null = null,
) {
  // The response stream owns the handle after construction. Before that, the operation owns it.
  let transferred = false;
  return yield* Effect.acquireUseRelease(
    remoteCall(() => open(path, "r")),
    (file) =>
      Effect.gen(function* () {
        const close = Effect.fn("FileResponse.close")(() => remoteCall(() => file.close()));
        const stats = yield* remoteCall(() => file.stat());
        if (!stats.isFile()) return yield* new RemoteWorkflowError({ cause: new Error("Not a regular file.") });
        const range = parseByteRange(rangeHeader, stats.size);
        if (range === "invalid") {
          return new Response(null, {
            status: 416,
            headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${stats.size}` },
          });
        }
        let position = range?.start ?? 0;
        let remaining = range ? range.end - range.start + 1 : stats.size;
        const responseHeaders = {
          ...headers,
          "Accept-Ranges": "bytes",
          "Content-Length": String(remaining),
          ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${stats.size}` } : {}),
        };
        const pull = Effect.fn("FileResponse.read")(function* (
          controller: ReadableStreamDefaultController<Uint8Array>,
        ) {
          if (remaining === 0) {
            controller.close();
            yield* close();
            return;
          }
          const chunk = new Uint8Array(Math.min(CHUNK_BYTES, remaining));
          const { bytesRead } = yield* remoteCall(() => file.read(chunk, 0, chunk.byteLength, position));
          if (bytesRead === 0) {
            controller.error(new Error("The file ended before the requested byte range was complete."));
            yield* close();
            return;
          }
          position += bytesRead;
          remaining -= bytesRead;
          controller.enqueue(chunk.subarray(0, bytesRead));
        });
        const body = new ReadableStream<Uint8Array>({
          pull: (controller) =>
            runCauseEffect(
              pull(controller).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    controller.error(error.cause);
                    yield* close().pipe(Effect.catch(() => Effect.void));
                  }),
                ),
              ),
            ),
          cancel: () => runCauseEffect(close()),
        });
        // Media elements need the length to show a duration.
        const response = new Response(body, { status: range ? 206 : 200, headers: responseHeaders });
        transferred = true;
        return response;
      }),
    (file) => (transferred ? Effect.void : remoteCall(() => file.close()).pipe(Effect.catch(() => Effect.void))),
  );
});
