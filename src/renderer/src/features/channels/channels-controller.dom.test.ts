import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOpenbotStub } from "../../app-test-harness";
import { createChannelsController } from "./channels-controller";
import { channelsPort } from "./channels-port";

describe("channel startup loading", () => {
  let dispose: (() => void) | undefined;

  beforeEach(installOpenbotStub);

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("loads channels when remote capability negotiation completes after startup", async () => {
    const [supported, setSupported] = createSignal(false);
    const listChannels = vi.spyOn(window.openbot.agent, "listChannels").mockResolvedValue([]);
    const port = channelsPort();

    createRoot((stop) => {
      dispose = stop;
      createChannelsController({
        port: () => port,
        agents: () => [],
        scopeKey: () => "account-1",
        readSelection: () => null,
        writeSelection: () => undefined,
        supported,
        deletionSupported: supported,
        beforeOpen: () => undefined,
        canMarkRead: () => false,
      });
    });

    expect(listChannels).not.toHaveBeenCalled();
    setSupported(true);
    await vi.waitFor(() => expect(listChannels).toHaveBeenCalledOnce());
  });
});
