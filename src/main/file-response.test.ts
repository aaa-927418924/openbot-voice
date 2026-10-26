import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { byteRangeResponse, fileResponse, parseByteRange } from "./file-response";

describe("fileResponse", () => {
  it("serves the whole file with the given headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-file-response-"));
    const path = join(directory, "image.png");
    const bytes = randomBytes(300_000);
    await writeFile(path, bytes);

    const response = await runCauseEffect(
      fileResponse(path, { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" }),
    );

    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("streams only the requested range for media seeking", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-file-response-"));
    const path = join(directory, "clip.mp4");
    const bytes = Buffer.from("0123456789");
    await writeFile(path, bytes);

    const response = await runCauseEffect(fileResponse(path, { "Content-Type": "video/mp4" }, "bytes=3-6"));

    expect(response.status).toBe(206);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Range")).toBe("bytes 3-6/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("3456");
  });

  it("supports suffix ranges and rejects unsatisfiable ranges", async () => {
    const suffix = byteRangeResponse(Buffer.from("0123456789"), { "Content-Type": "video/mp4" }, "bytes=-3");

    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("Content-Range")).toBe("bytes 7-9/10");
    expect(Buffer.from(await suffix.arrayBuffer()).toString()).toBe("789");

    const invalid = byteRangeResponse(Buffer.from("0123456789"), {}, "bytes=10-");
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("parses open-ended and suffix ranges without accepting malformed requests", () => {
    expect(parseByteRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(parseByteRange("bytes=-20", 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange("bytes=1-2,4-5", 10)).toBe("invalid");
  });

  it("rejects a file that cannot be opened, so the protocol can answer 404", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-file-response-"));

    await expect(runCauseEffect(fileResponse(join(directory, "missing.png"), {}))).rejects.toThrow(/ENOENT/);
  });

  it("rejects a directory instead of a body that fails after the headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-file-response-"));

    await expect(runCauseEffect(fileResponse(directory, {}))).rejects.toThrow("Not a regular file.");
  });
});
