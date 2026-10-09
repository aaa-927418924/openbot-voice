import { describe, expect, it } from "vitest";
import { parseRustTracingSeverity } from "./provider-diagnostics";

describe("parseRustTracingSeverity", () => {
  it("reads the level from timestamped text records after removing ANSI color", () => {
    expect(
      parseRustTracingSeverity(
        "\u001B[2m2026-10-09T12:00:00.000000Z\u001B[0m  \u001B[33mWARN\u001B[0m codex_core::realtime: request failed; retrying",
      ),
    ).toBe("WARN");
  });

  it("reads the level from a JSON record without inspecting its message", () => {
    expect(
      parseRustTracingSeverity(
        '{"timestamp":"2026-10-09T12:00:00Z","level":"WARN","fields":{"message":"request failed"},"target":"codex_core::realtime"}',
      ),
    ).toBe("WARN");
  });

  it("recognizes structured ERROR records and rejects severity words in plain messages", () => {
    expect(parseRustTracingSeverity("2026-10-09T12:00:00Z ERROR codex_core::realtime: request failed")).toBe("ERROR");
    expect(parseRustTracingSeverity("the provider warned that a request failed")).toBeNull();
    expect(parseRustTracingSeverity("WARN provider: request failed")).toBeNull();
    expect(parseRustTracingSeverity("2026-10-09T12:00:00 WARN codex_core::realtime: request failed")).toBeNull();
    expect(parseRustTracingSeverity("2026-02-31T12:00:00Z WARN codex_core::realtime: request failed")).toBeNull();
    expect(parseRustTracingSeverity('{"level":"WARN","message":"request failed"}')).toBeNull();
  });
});
