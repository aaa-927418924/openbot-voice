// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { mirrorLocalServerVisibility } from "./local-server-visibility-mirror";

describe("mirrorLocalServerVisibility", () => {
  it("keeps an authoritative account update successful when the device-local mirror fails", async () => {
    const failure = new Error("local directory is unavailable");
    const directory = { setServerVisible: vi.fn().mockRejectedValue(failure) };
    const onFailure = vi.fn();

    await expect(mirrorLocalServerVisibility(directory, "host-1", true, onFailure)).resolves.toBeUndefined();

    expect(directory.setServerVisible).toHaveBeenCalledWith("host-1", true);
    expect(onFailure).toHaveBeenCalledWith(failure);
  });

  it("does not write when there is no local host", async () => {
    const directory = { setServerVisible: vi.fn() };
    const onFailure = vi.fn();

    await mirrorLocalServerVisibility(directory, undefined, false, onFailure);

    expect(directory.setServerVisible).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
