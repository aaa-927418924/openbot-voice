import { describe, expect, it } from "vitest";
import { isMainWindowControlAction } from "./ipc-titlebar";

describe("main window control actions", () => {
  it("accepts only supported window actions", () => {
    expect(isMainWindowControlAction("minimize")).toBe(true);
    expect(isMainWindowControlAction("toggle-maximize")).toBe(true);
    expect(isMainWindowControlAction("close")).toBe(true);
    expect(isMainWindowControlAction("restore")).toBe(false);
    expect(isMainWindowControlAction(null)).toBe(false);
  });
});
