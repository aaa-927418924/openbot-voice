// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalTailnetHostStartRetry } from "./local-tailnet-host-start-retry";

const online = { phase: "online" as const, apiOnline: true, message: null };
const offline = { phase: "error" as const, apiOnline: false, message: "Tailscale is not connected." };

afterEach(() => vi.useRealTimers());

describe("LocalTailnetHostStartRetry", () => {
  it("retries after Tailscale is unavailable and stops after the host starts", async () => {
    vi.useFakeTimers();
    const startHost = vi
      .fn()
      .mockResolvedValueOnce(offline)
      .mockResolvedValueOnce(online)
      .mockResolvedValueOnce(online);
    const onError = vi.fn();
    const retry = new LocalTailnetHostStartRetry({ startHost, onError });

    const initial = retry.start();
    await expect(initial).resolves.toMatchObject(offline);
    expect(startHost).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(startHost).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(startHost).toHaveBeenCalledTimes(2);
    // The explicit call can recover immediately while the retry loop is already running.
    await expect(retry.start()).resolves.toMatchObject(online);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startHost).toHaveBeenCalledTimes(3);
    await retry.stop();
  });

  it("cancels a scheduled retry when the application stops", async () => {
    vi.useFakeTimers();
    const startHost = vi.fn().mockResolvedValue(offline);
    const retry = new LocalTailnetHostStartRetry({ startHost, onError: vi.fn() });

    await expect(retry.start()).resolves.toMatchObject(offline);
    await vi.waitFor(() => expect(startHost).toHaveBeenCalledTimes(1));
    await retry.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(startHost).toHaveBeenCalledTimes(1);
  });
});
