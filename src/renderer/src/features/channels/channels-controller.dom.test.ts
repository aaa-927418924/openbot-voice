import type { Channel, ChannelMessage, ChannelSummary } from "@openbot/contracts/ipc";
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

describe("channel history mutations", () => {
  let disposeController: (() => void) | undefined;

  beforeEach(installOpenbotStub);
  afterEach(() => {
    disposeController?.();
    disposeController = undefined;
  });

  it("removes a deleted older row from the loaded transcript before a refresh can merge it back", async () => {
    const channel: Channel = {
      id: "channel-history",
      name: "History",
      title: "",
      instructions: "",
      members: [],
      leadAgentId: null,
      archived: false,
      revision: 0,
      createdAt: new Date().toISOString(),
    };
    const rows: ChannelMessage[] = [historyMessage(1), historyMessage(2)];
    const summary = (): ChannelSummary => ({
      ...channel,
      unreadCount: 0,
      activeTasks: 0,
      lastMessage: rows.at(-1) ? { authorName: "You", text: rows.at(-1)?.message.text ?? "", at: "now" } : null,
    });
    const listChannels = vi.spyOn(window.openbot.agent, "listChannels").mockImplementation(async () => [summary()]);
    const readChannel = vi.spyOn(window.openbot.agent, "readChannel").mockImplementation(async ({ beforeSequence }) => {
      const messages =
        beforeSequence === undefined
          ? rows.filter((row) => row.sequence > 1)
          : rows.filter((row) => row.sequence < beforeSequence);
      return {
        channel,
        messages,
        tasks: [],
        olderCursor: beforeSequence === undefined && rows.length > 1 ? 2 : null,
        throughSequence: rows.at(-1)?.sequence ?? 0,
      };
    });
    const deleteChannelMessage = vi
      .spyOn(window.openbot.agent, "deleteChannelMessage")
      .mockImplementation(async ({ messageId }) => {
        const index = rows.findIndex((row) => row.id === messageId);
        if (index >= 0) rows.splice(index, 1);
      });
    const clearChannelHistory = vi.spyOn(window.openbot.agent, "clearChannelHistory").mockImplementation(async () => {
      rows.splice(0);
    });
    const port = channelsPort();
    let controller!: ReturnType<typeof createChannelsController>;
    createRoot((stop) => {
      disposeController = stop;
      controller = createChannelsController({
        port: () => port,
        agents: () => [],
        scopeKey: () => "account-1",
        readSelection: () => channel.id,
        writeSelection: () => undefined,
        supported: () => true,
        deletionSupported: () => true,
        beforeOpen: () => undefined,
        canMarkRead: () => false,
      });
    });

    await vi.waitFor(() => expect(controller.state.page?.messages).toHaveLength(1));
    await controller.loadOlder();
    expect(controller.state.page?.messages.map((row) => row.id)).toEqual(["channel-message-1", "channel-message-2"]);
    await controller.deleteChannelMessage(channel.id, "channel-message-1");
    expect(controller.state.page?.messages.map((row) => row.id)).toEqual(["channel-message-2"]);

    await controller.clearChannelHistory(channel.id);
    expect(controller.state.page?.messages).toEqual([]);
    expect(deleteChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: channel.id, messageId: "channel-message-1" }),
    );
    expect(clearChannelHistory).toHaveBeenCalledWith(expect.objectContaining({ channelId: channel.id }));
    expect(listChannels).toHaveBeenCalled();
    expect(readChannel).toHaveBeenCalled();
  });
});

function historyMessage(sequence: number): ChannelMessage {
  const id = `channel-message-${sequence}`;
  return {
    id,
    channelId: "channel-history",
    sequence,
    author: { kind: "member", id: "local", name: "You" },
    taskId: null,
    superseded: false,
    message: {
      id,
      author: "user",
      text: `Message ${sequence}`,
      createdAt: new Date(2026, 8, 1, 9, sequence).toISOString(),
      status: "completed",
    },
  };
}
