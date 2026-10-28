import { describe, expect, it, vi } from "vitest";
import { ensureMicrophonePermission } from "./android-microphone-permission";

describe("Live Voice microphone permission", () => {
  it("does not prompt again after Android granted the microphone permission", async () => {
    const requestPermission = vi.fn(async () => true);
    await expect(ensureMicrophonePermission({ hasPermission: async () => true, requestPermission })).resolves.toBe(
      true,
    );
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("requests access on start and reports a denial", async () => {
    const hasPermission = vi.fn(async () => false);
    const requestPermission = vi.fn(async () => false);
    await expect(ensureMicrophonePermission({ hasPermission, requestPermission })).resolves.toBe(false);
    expect(hasPermission).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalledOnce();
  });
});
