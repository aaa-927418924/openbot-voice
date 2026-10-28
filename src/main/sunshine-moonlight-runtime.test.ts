import { describe, expect, it } from "vitest";
import {
  createScreenCaptureDenialWatcher,
  shouldFailForUnrestoredSunshinePortalToken,
  shouldResetSunshinePortalTokenAfterFailedStart,
  sunshineStartupPolicy,
} from "./sunshine-moonlight-runtime";

// A refused Screen Recording grant is visible only in what Sunshine prints, and the pipe splits that
// text wherever it happens to fill. Missing the marker leaves a member's session at "connecting"
// with no error naming what the host owner has to grant.
describe("createScreenCaptureDenialWatcher", () => {
  it("finds the denial spread over three reads", () => {
    const saidCaptureDenied = createScreenCaptureDenialWatcher();
    expect(saidCaptureDenied("[warning] No scr")).toBe(false);
    expect(saidCaptureDenied("een capture ")).toBe(false);
    expect(saidCaptureDenied("permission!\n")).toBe(true);
  });

  it("says nothing about a host that starts normally", () => {
    const saidCaptureDenied = createScreenCaptureDenialWatcher();
    expect(saidCaptureDenied("Found H.264 encoder: h264_videotoolbox\n")).toBe(false);
    expect(saidCaptureDenied("Starting main loop\n")).toBe(false);
  });
});

describe("Sunshine Portal token recovery", () => {
  it("resets an OpenBot Wayland Portal token that loaded but never restored a stream", () => {
    expect(
      shouldResetSunshinePortalTokenAfterFailedStart({
        platform: "linux",
        linuxCaptureMethod: "portal",
        restoreTokenLoaded: true,
        captureStreamStarted: false,
      }),
    ).toBe(true);
    expect(
      shouldResetSunshinePortalTokenAfterFailedStart({
        platform: "linux",
        linuxCaptureMethod: "portal",
        restoreTokenLoaded: true,
        captureStreamStarted: true,
      }),
    ).toBe(false);
    expect(
      shouldResetSunshinePortalTokenAfterFailedStart({
        platform: "linux",
        linuxCaptureMethod: "x11",
        restoreTokenLoaded: true,
        captureStreamStarted: false,
      }),
    ).toBe(false);
  });

  it("starts the recovery grace period when Sunshine reads the saved token", () => {
    const base = {
      platform: "linux" as const,
      linuxCaptureMethod: "portal" as const,
      restoreTokenLoadedAt: 1_000,
      captureStreamStarted: false,
      graceMs: 5_000,
    };
    expect(shouldFailForUnrestoredSunshinePortalToken({ ...base, now: 5_999 })).toBe(false);
    expect(shouldFailForUnrestoredSunshinePortalToken({ ...base, now: 6_000 })).toBe(true);
    expect(shouldFailForUnrestoredSunshinePortalToken({ ...base, now: 6_000, captureStreamStarted: true })).toBe(false);
    expect(
      shouldFailForUnrestoredSunshinePortalToken({
        ...base,
        platform: "win32",
        now: 6_000,
      }),
    ).toBe(false);
  });
});

describe("Sunshine startup policy", () => {
  it("keeps a Wayland Portal request alive for host approval without restarting it", () => {
    expect(sunshineStartupPolicy("linux", "portal")).toEqual({ timeoutMs: 120_000, attempts: 1 });
  });

  it("preserves the normal retry policy outside the Wayland Portal flow", () => {
    expect(sunshineStartupPolicy("linux", "x11")).toEqual({ timeoutMs: 20_000, attempts: 3 });
    expect(sunshineStartupPolicy("win32")).toEqual({ timeoutMs: 20_000, attempts: 3 });
  });
});
