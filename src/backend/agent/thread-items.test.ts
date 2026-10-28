// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AppServerError } from "../app-server-client";
import { isMissingProviderSessionError } from "./thread-items";

describe("isMissingProviderSessionError", () => {
  it("recognizes a Codex app-server thread that is no longer loaded", () => {
    expect(
      isMissingProviderSessionError(
        new AppServerError("thread not loaded: 01a10bf1-12a0-7a90-8d81-6d401ac1aa7e", -32000),
        "codex",
      ),
    ).toBe(true);
  });

  it("does not treat unrelated Codex errors or another provider as a missing session", () => {
    expect(isMissingProviderSessionError(new AppServerError("thread not loaded", -32000), "codex")).toBe(false);
    expect(
      isMissingProviderSessionError(
        new AppServerError("thread not loaded: 01a10bf1-12a0-7a90-8d81-6d401ac1aa7e", -32000),
        "claude",
      ),
    ).toBe(false);
  });
});
