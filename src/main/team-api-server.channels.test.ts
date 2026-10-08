import { type ChannelMessage, decodeChannelPage } from "@openbot/contracts/ipc";
import {
  CLEAR_CHANNEL_HISTORY_ROUTE,
  DELETE_CHANNEL_MESSAGE_ROUTE,
} from "@openbot/contracts/team-protocol/channel-history-delete-v1";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { stores } from "../backend/agent-service-test-harness";
import { ChannelService } from "../backend/channel-service";
import { createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await stopTeamApiFixtures();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Team API channel access", () => {
  it("requires the capability and derives authorship from the signed-in caller", async () => {
    const fixture = await createTeamApiFixture("channels", { configure: true });
    const data = stores(fixture.root);
    await Effect.runPromise(data.store.initialize());
    await Effect.runPromise(data.mailbox.initialize());
    const channels = new ChannelService(data.store.database, data.mailbox, {
      agents: () => [],
      generate: () => Effect.sync(() => ""),
      schedule: () => undefined,
      interrupt: () => Effect.sync(() => undefined),
      busy: () => false,
      changed: () => undefined,
      error: () => undefined,
    });
    cleanups.push(async () => {
      await Effect.runPromise(channels.stop());
      data.store.database.close();
    });
    const { base } = await fixture.start({ channels });
    const token = await fixture.signIn();
    const headers = {
      Authorization: `Bearer ${token}`,
      "OpenBot-Protocol-Version": "3",
      "OpenBot-Capabilities": "channel-chats-v1",
      "Content-Type": "application/json",
    };
    expect((await fetch(`${base}/v1/channels`, { headers: { ...headers, "OpenBot-Capabilities": "" } })).status).toBe(
      400,
    );
    expect(
      (await fetch(`${base}/v1/channels`, { headers: { ...headers, Authorization: "Bearer invalid" } })).status,
    ).toBe(401);
    const create = await fetch(`${base}/v1/channels/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "save",
        operationId: "create",
        channelId: "channel-1",
        draft: { name: "Project", title: "", instructions: "Work together", members: [], leadAgentId: null },
      }),
    });
    expect(create.status).toBe(200);
    const send = await fetch(`${base}/v1/channels/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "send",
        operationId: "send",
        channelId: "channel-1",
        text: "Hello",
        recipientAgentId: null,
        replyToMessageId: null,
        attachmentDraftIds: [],
        author: { id: "impostor", name: "Impostor" },
      }),
    });
    expect(send.status).toBe(200);
    const read = await fetch(`${base}/v1/channels/read`, {
      method: "POST",
      headers,
      body: JSON.stringify({ channelId: "channel-1" }),
    });
    const page = decodeChannelPage(await read.json());
    expect(page.messages[0]?.author.id).not.toBe("impostor");
    expect(page.messages[0]?.author.kind).toBe("member");
    channels.store.update(channels.store.get("channel-1"), {
      tasks: channels.store.tasks("channel-1").map((task) => ({ ...task, state: "completed" })),
      assignments: channels.store.assignments("channel-1").map((assignment) => ({
        ...assignment,
        state: "completed",
        deliveryId: null,
        turnId: null,
      })),
    });
    const channelMessage: ChannelMessage = {
      id: "channel-history-row",
      channelId: "channel-1",
      sequence: 0,
      author: { kind: "member", id: "member-1", name: "Team member" },
      taskId: null,
      superseded: false,
      message: {
        id: "channel-history-row",
        author: "user",
        text: "Only channel history is removed.",
        createdAt: new Date().toISOString(),
        status: "completed",
      },
    };
    channels.store.update(channels.store.get("channel-1"), { messages: [channelMessage] });
    const historyHeaders = { ...headers, "OpenBot-Capabilities": "channel-chats-v1,channel-history-delete-v1" };
    const legacyHistoryRoute = await fetch(`${base}${DELETE_CHANNEL_MESSAGE_ROUTE}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ channelId: "channel-1", messageId: "channel-history-row", operationId: "old-client" }),
    });
    expect(legacyHistoryRoute.status).toBe(400);
    const deletedMessage = await fetch(`${base}${DELETE_CHANNEL_MESSAGE_ROUTE}`, {
      method: "POST",
      headers: historyHeaders,
      body: JSON.stringify({ channelId: "channel-1", messageId: "channel-history-row", operationId: "delete-row" }),
    });
    expect(deletedMessage.status).toBe(200);
    expect(channels.store.message("channel-1", "channel-history-row")).toBeNull();

    channels.store.update(channels.store.get("channel-1"), { messages: [channelMessage] });
    const clearedHistory = await fetch(`${base}${CLEAR_CHANNEL_HISTORY_ROUTE}`, {
      method: "POST",
      headers: historyHeaders,
      body: JSON.stringify({ channelId: "channel-1", operationId: "clear-history" }),
    });
    expect(clearedHistory.status).toBe(200);
    expect(channels.store.messages("channel-1")).toEqual([]);
    expect(channels.store.exists("channel-1")).toBe(true);

    const deleteBody = JSON.stringify({ channelId: "channel-1" });
    const withoutDeleteCapability = await fetch(`${base}/v1/channels/delete`, {
      method: "POST",
      headers,
      body: deleteBody,
    });
    expect(withoutDeleteCapability.status).toBe(400);
    const invite = await Effect.runPromise(fixture.store.createInvite("member"));
    const member = await Effect.runPromise(fixture.store.acceptInvite(invite.token, "member", "member password"));
    const memberDelete = await fetch(`${base}/v1/channels/delete`, {
      method: "POST",
      headers: {
        ...headers,
        Authorization: `Bearer ${member.sessionToken}`,
        "OpenBot-Capabilities": "channel-chats-v1,channel-delete-v1",
      },
      body: deleteBody,
    });
    expect(memberDelete.status).toBe(403);
    const deleted = await fetch(`${base}/v1/channels/delete`, {
      method: "POST",
      headers: {
        ...headers,
        "OpenBot-Capabilities": "channel-chats-v1,channel-delete-v1",
      },
      body: deleteBody,
    });
    expect(deleted.status).toBe(204);
    expect(channels.store.exists("channel-1")).toBe(false);
    const legacy = await createTeamApiFixture("no-channels");
    const old = await legacy.start();
    const compatibility = await fetch(`${old.base}/v1/compatibility`);
    expect(await compatibility.json()).toMatchObject({
      capabilities: expect.not.arrayContaining(["channel-chats-v1"]),
    });
  });
});
