import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { databaseRow, databaseRows, requiredStringColumn } from "../backend/database/database-rows";
import { directThreadId } from "../backend/team-chat-store";
import { remapMigratedMemberIdentities } from "./server-migration-identities";

describe("remapMigratedMemberIdentities", () => {
  let database: DatabaseSync;

  afterEach(() => database?.close());

  it("rewrites typed collaboration events, receipts, and projections while preserving text and opaque IDs", () => {
    database = createDatabase();
    const oldMember = "device-a";
    const newMember = "account-a";
    const peer = "peer-b";
    const oldThread = directThreadId(oldMember, peer);
    const newThread = directThreadId(newMember, peer);
    const userConversationMessage = {
      id: "thread-message-1",
      author: "user" as const,
      text: `thread text ${oldMember}`,
      createdAt: "created",
      status: "completed" as const,
      senderMember: { id: oldMember, name: oldMember },
    };
    database
      .prepare("INSERT INTO projection_direct_threads VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(oldThread, oldMember, peer, "created", "updated", "message-device-a-1", 3);
    database.prepare("INSERT INTO projection_direct_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "message-device-a-1",
      oldThread,
      oldMember,
      peer,
      `message mentions ${oldMember}`,
      "created",
      JSON.stringify({
        id: "message-device-a-1",
        threadId: oldThread,
        senderMemberId: oldMember,
        recipientMemberId: peer,
        text: `message mentions ${oldMember}`,
        createdAt: "created",
        sequence: 3,
      }),
      3,
    );
    database.prepare("INSERT INTO projection_direct_reads VALUES (?, ?, ?, ?)").run(oldThread, oldMember, 3, "read");
    database.prepare("INSERT INTO projection_channel_messages VALUES (?, ?)").run(
      "channel-message-1",
      JSON.stringify({
        message: {
          author: { kind: "member", id: oldMember, identityId: oldMember, name: oldMember },
          text: `message mentions ${oldMember}`,
        },
        senderMember: { id: oldMember, name: oldMember, identity: { id: oldMember, identityId: oldMember } },
      }),
    );
    database.prepare("INSERT INTO projection_channel_reads VALUES (?, ?, ?)").run("channel-1", oldMember, 8);
    database
      .prepare("INSERT INTO projection_thread_reads VALUES (?, ?, ?)")
      .run("agent-thread", oldMember, "message-8");
    database.prepare("INSERT INTO projection_thread_messages VALUES (?)").run(JSON.stringify(userConversationMessage));

    const directMessageCommand = `direct-message:${oldMember}:message-device-a-1`;
    const directMessageSequence = insertEvent(database, {
      commandId: directMessageCommand,
      aggregateType: "direct-thread",
      aggregateId: oldThread,
      eventType: "direct-message.sent",
      payload: {
        id: "message-device-a-1",
        threadId: oldThread,
        senderMemberId: oldMember,
        recipientMemberId: peer,
        text: `message mentions ${oldMember}`,
        createdAt: "created",
        sequence: 0,
      },
    });
    insertReceipt(database, directMessageCommand, {
      id: "message-device-a-1",
      threadId: oldThread,
      senderMemberId: oldMember,
      recipientMemberId: peer,
      text: `message mentions ${oldMember}`,
      createdAt: "created",
      sequence: directMessageSequence,
    });

    const directReadCommand = `direct-read:${oldThread}:${oldMember}:3`;
    insertEvent(database, {
      commandId: directReadCommand,
      aggregateType: "direct-thread",
      aggregateId: oldThread,
      eventType: "direct-thread.read",
      payload: { memberId: oldMember, throughSequence: 3 },
    });
    insertReceipt(database, directReadCommand, null);

    const threadReadCommand = `thread-read:marked:agent-thread:${oldMember}:opaque:${oldMember}`;
    insertEvent(database, {
      commandId: threadReadCommand,
      aggregateType: "thread-read",
      aggregateId: `agent-thread:${oldMember}`,
      eventType: "thread-read.marked",
      payload: { threadId: "agent-thread", memberId: oldMember, throughMessageId: "message-8" },
    });
    insertReceipt(database, threadReadCommand, null);

    // The suffix is an opaque operation ID and may itself contain the old member ID.
    const channelReadCommand = `channel-read:${oldMember}:adopt:${oldMember}:channel-1`;
    insertEvent(database, {
      commandId: channelReadCommand,
      aggregateType: "channel",
      aggregateId: "channel-1",
      eventType: "channel.read",
      payload: { memberId: oldMember, throughSequence: 8 },
    });
    const channelReadReceipt = { channelId: "channel-1", text: `opaque ${oldMember}` };
    insertReceipt(database, channelReadCommand, channelReadReceipt);

    const channelMessage = {
      id: "channel-message-1",
      channelId: "channel-1",
      sequence: 9,
      author: { kind: "member" as const, id: oldMember, identityId: oldMember, name: oldMember },
      taskId: null,
      superseded: false,
      message: {
        id: "conversation-message-1",
        author: "user" as const,
        text: `typed text ${oldMember}`,
        createdAt: "created",
        status: "completed" as const,
        senderMember: { id: oldMember, name: oldMember },
      },
    };
    const channelChangeCommand = `channels:${oldMember}:save-op:${oldMember}`;
    insertEvent(database, {
      commandId: channelChangeCommand,
      aggregateType: "channel",
      aggregateId: "channel-1",
      eventType: "channel.changed",
      payload: { channel: { id: "channel-1" }, messages: [channelMessage], tasks: [], assignments: [] },
    });
    const channelChangeReceipt = { id: "channel-1", text: `leave ${oldMember} untouched` };
    insertReceipt(database, channelChangeCommand, channelChangeReceipt);

    const snapshotCommand = `conversation:thread.snapshot-written:opaque:${oldMember}`;
    insertEvent(database, {
      commandId: snapshotCommand,
      aggregateType: "thread",
      aggregateId: "agent-thread",
      eventType: "thread.snapshot-written",
      payload: {
        detail: { senderMember: { id: oldMember }, text: `do not touch ${oldMember}` },
        snapshot: { threadId: "agent-thread", messages: [userConversationMessage] },
        recovery: { opaque: oldMember },
      },
    });
    const snapshotReceipt = { text: `receipt remains ${oldMember}` };
    insertReceipt(database, snapshotCommand, snapshotReceipt);

    const appendCommand = `conversation:thread.message-appended:opaque:${oldMember}`;
    insertEvent(database, {
      commandId: appendCommand,
      aggregateType: "thread",
      aggregateId: "agent-thread",
      eventType: "thread.message-appended",
      payload: {
        detail: { text: `do not touch ${oldMember}` },
        appendedMessage: userConversationMessage,
        activeTurnId: null,
      },
    });
    insertReceipt(database, appendCommand, null);

    const unknownCommand = `conversation:${oldMember}:opaque`;
    insertEvent(database, {
      commandId: unknownCommand,
      aggregateType: "thread",
      aggregateId: "agent-thread",
      eventType: "conversation.message",
      payload: { memberId: oldMember, text: `must remain ${oldMember}` },
    });
    const unknownReceipt = { memberId: oldMember, text: `must remain ${oldMember}` };
    insertReceipt(database, unknownCommand, unknownReceipt);

    remapMigratedMemberIdentities(database, new Map([[oldMember, newMember]]));

    expect(database.prepare("SELECT member_a_id, member_b_id, thread_id FROM projection_direct_threads").get()).toEqual(
      {
        member_a_id: newMember,
        member_b_id: peer,
        thread_id: newThread,
      },
    );
    expect(
      database
        .prepare("SELECT thread_id, sender_member_id, recipient_member_id, text FROM projection_direct_messages")
        .get(),
    ).toEqual({
      thread_id: newThread,
      sender_member_id: newMember,
      recipient_member_id: peer,
      text: `message mentions ${oldMember}`,
    });
    expect(database.prepare("SELECT thread_id, member_id FROM projection_direct_reads").get()).toEqual({
      thread_id: newThread,
      member_id: newMember,
    });
    expect(database.prepare("SELECT member_id, through_sequence FROM projection_channel_reads").get()).toEqual({
      member_id: newMember,
      through_sequence: 8,
    });
    expect(database.prepare("SELECT member_id, through_message_id FROM projection_thread_reads").get()).toEqual({
      member_id: newMember,
      through_message_id: "message-8",
    });
    expect(
      JSON.parse(String(database.prepare("SELECT message_json FROM projection_direct_messages").get()?.message_json)),
    ).toMatchObject({
      threadId: newThread,
      senderMemberId: newMember,
      recipientMemberId: peer,
      text: `message mentions ${oldMember}`,
    });
    expect(
      JSON.parse(String(database.prepare("SELECT message_json FROM projection_channel_messages").get()?.message_json)),
    ).toMatchObject({
      message: {
        author: { kind: "member", id: newMember, identityId: newMember, name: oldMember },
        text: `message mentions ${oldMember}`,
      },
      senderMember: { id: newMember, name: oldMember, identity: { id: newMember, identityId: newMember } },
    });
    expect(
      JSON.parse(String(database.prepare("SELECT message_json FROM projection_thread_messages").get()?.message_json)),
    ).toEqual({ ...userConversationMessage, senderMember: { id: newMember, name: oldMember } });

    const events = databaseRows(
      database
        .prepare(
          "SELECT event_type, command_id, aggregate_id, payload_json FROM orchestration_events ORDER BY sequence",
        )
        .all(),
    ).map((value) => {
      const row = databaseRow(value);
      if (!row) throw new Error("Invalid test event row.");
      return {
        event_type: requiredStringColumn(row, "event_type"),
        command_id: requiredStringColumn(row, "command_id"),
        aggregate_id: requiredStringColumn(row, "aggregate_id"),
        payload_json: requiredStringColumn(row, "payload_json"),
      };
    });
    expect(events[0]).toMatchObject({
      event_type: "direct-message.sent",
      command_id: `direct-message:${newMember}:message-device-a-1`,
      aggregate_id: newThread,
    });
    expect(JSON.parse(events[0]?.payload_json ?? "{}")).toEqual({
      id: "message-device-a-1",
      threadId: newThread,
      senderMemberId: newMember,
      recipientMemberId: peer,
      text: `message mentions ${oldMember}`,
      createdAt: "created",
      sequence: 0,
    });
    expect(events[1]).toMatchObject({
      event_type: "direct-thread.read",
      command_id: `direct-read:${newThread}:${newMember}:3`,
      aggregate_id: newThread,
    });
    expect(JSON.parse(events[1]?.payload_json ?? "{}")).toEqual({ memberId: newMember, throughSequence: 3 });
    expect(events[2]).toMatchObject({
      event_type: "thread-read.marked",
      command_id: `thread-read:marked:agent-thread:${newMember}:opaque:${oldMember}`,
      aggregate_id: `agent-thread:${newMember}`,
    });
    expect(JSON.parse(events[2]?.payload_json ?? "{}")).toEqual({
      threadId: "agent-thread",
      memberId: newMember,
      throughMessageId: "message-8",
    });
    expect(events[3]).toMatchObject({
      event_type: "channel.read",
      command_id: `channel-read:${newMember}:adopt:${oldMember}:channel-1`,
      aggregate_id: "channel-1",
    });
    expect(JSON.parse(events[3]?.payload_json ?? "{}")).toEqual({ memberId: newMember, throughSequence: 8 });
    expect(events[4]).toMatchObject({
      event_type: "channel.changed",
      command_id: `channels:${newMember}:save-op:${oldMember}`,
      aggregate_id: "channel-1",
    });
    expect(JSON.parse(events[4]?.payload_json ?? "{}")).toMatchObject({
      messages: [
        {
          author: { kind: "member", id: newMember, identityId: newMember, name: oldMember },
          message: { text: `typed text ${oldMember}`, senderMember: { id: newMember, name: oldMember } },
        },
      ],
    });
    expect(events[5]).toMatchObject({
      event_type: "thread.snapshot-written",
      command_id: snapshotCommand,
      aggregate_id: "agent-thread",
    });
    expect(JSON.parse(events[5]?.payload_json ?? "{}")).toEqual({
      detail: { senderMember: { id: oldMember }, text: `do not touch ${oldMember}` },
      snapshot: {
        threadId: "agent-thread",
        messages: [{ ...userConversationMessage, senderMember: { id: newMember, name: oldMember } }],
      },
      recovery: { opaque: oldMember },
    });
    expect(events[6]).toMatchObject({
      event_type: "thread.message-appended",
      command_id: appendCommand,
      aggregate_id: "agent-thread",
    });
    expect(JSON.parse(events[6]?.payload_json ?? "{}")).toEqual({
      detail: { text: `do not touch ${oldMember}` },
      appendedMessage: { ...userConversationMessage, senderMember: { id: newMember, name: oldMember } },
      activeTurnId: null,
    });
    expect(events[7]).toMatchObject({
      event_type: "conversation.message",
      command_id: unknownCommand,
      aggregate_id: "agent-thread",
      payload_json: JSON.stringify({ memberId: oldMember, text: `must remain ${oldMember}` }),
    });

    expect(JSON.parse(readReceipt(database, `direct-message:${newMember}:message-device-a-1`) ?? "null")).toEqual({
      id: "message-device-a-1",
      threadId: newThread,
      senderMemberId: newMember,
      recipientMemberId: peer,
      text: `message mentions ${oldMember}`,
      createdAt: "created",
      sequence: directMessageSequence,
    });
    expect(JSON.parse(readReceipt(database, `direct-read:${newThread}:${newMember}:3`) ?? "undefined")).toBeNull();
    expect(
      JSON.parse(
        readReceipt(database, `thread-read:marked:agent-thread:${newMember}:opaque:${oldMember}`) ?? "undefined",
      ),
    ).toBeNull();
    expect(
      JSON.parse(readReceipt(database, `channel-read:${newMember}:adopt:${oldMember}:channel-1`) ?? "null"),
    ).toEqual(channelReadReceipt);
    expect(JSON.parse(readReceipt(database, `channels:${newMember}:save-op:${oldMember}`) ?? "null")).toEqual(
      channelChangeReceipt,
    );
    expect(JSON.parse(readReceipt(database, snapshotCommand) ?? "null")).toEqual(snapshotReceipt);
    expect(JSON.parse(readReceipt(database, appendCommand) ?? "undefined")).toBeNull();
    expect(JSON.parse(readReceipt(database, unknownCommand) ?? "null")).toEqual(unknownReceipt);
  });

  it("rejects command ID collisions before changing projections or event history", () => {
    database = createDatabase();
    const oldMember = "device-a";
    const targetMember = "account-a";
    database.prepare("INSERT INTO projection_channel_reads VALUES (?, ?, ?)").run("channel-1", oldMember, 5);
    const sourceCommand = `channel-read:${oldMember}:operation`;
    const targetCommand = `channel-read:${targetMember}:operation`;
    insertEvent(database, {
      commandId: sourceCommand,
      aggregateType: "channel",
      aggregateId: "channel-1",
      eventType: "channel.read",
      payload: { memberId: oldMember, throughSequence: 5 },
    });
    insertReceipt(database, sourceCommand, null);
    insertReceipt(database, targetCommand, null);

    expect(() => remapMigratedMemberIdentities(database, new Map([[oldMember, targetMember]]))).toThrow(
      "Member remapping would overwrite an existing orchestration command receipt.",
    );
    expect(database.prepare("SELECT member_id, through_sequence FROM projection_channel_reads").get()).toEqual({
      member_id: oldMember,
      through_sequence: 5,
    });
    expect(database.prepare("SELECT command_id FROM orchestration_events").get()).toEqual({
      command_id: sourceCommand,
    });
  });

  it("rolls back projection changes when an event rewrite fails inside the transaction", () => {
    database = createDatabase();
    const oldMember = "device-a";
    database.prepare("INSERT INTO projection_channel_reads VALUES (?, ?, ?)").run("channel-1", oldMember, 5);
    const commandId = `channel-read:${oldMember}:operation`;
    insertEvent(database, {
      commandId,
      aggregateType: "channel",
      aggregateId: "channel-1",
      eventType: "channel.read",
      payload: { memberId: oldMember, throughSequence: 5 },
    });
    insertReceipt(database, commandId, null);
    database.exec(`
      CREATE TRIGGER reject_event_rewrite BEFORE UPDATE OF payload_json ON orchestration_events
      BEGIN SELECT RAISE(ABORT, 'test event write failure'); END;
    `);

    expect(() => remapMigratedMemberIdentities(database, new Map([[oldMember, "account-a"]]))).toThrow(
      "test event write failure",
    );
    expect(database.prepare("SELECT member_id, through_sequence FROM projection_channel_reads").get()).toEqual({
      member_id: oldMember,
      through_sequence: 5,
    });
    expect(
      JSON.parse(String(database.prepare("SELECT payload_json FROM orchestration_events").get()?.payload_json)),
    ).toEqual({
      memberId: oldMember,
      throughSequence: 5,
    });
  });

  it("rejects merging channel read cursors instead of dropping one", () => {
    database = createDatabase();
    database.prepare("INSERT INTO projection_channel_reads VALUES (?, ?, ?)").run("channel-1", "device-a", 5);
    database.prepare("INSERT INTO projection_channel_reads VALUES (?, ?, ?)").run("channel-1", "account-a", 8);

    expect(() => remapMigratedMemberIdentities(database, new Map([["device-a", "account-a"]]))).toThrow(
      "Member remapping would merge channel read cursors.",
    );
    expect(database.prepare("SELECT member_id FROM projection_channel_reads ORDER BY member_id").all()).toEqual([
      { member_id: "account-a" },
      { member_id: "device-a" },
    ]);
  });
});

function insertEvent(
  database: DatabaseSync,
  event: {
    commandId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: unknown;
  },
): number {
  const result = database
    .prepare(
      `INSERT INTO orchestration_events (
        event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `event-${Math.random()}`,
      event.commandId,
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      "created",
      JSON.stringify(event.payload),
    );
  return Number(result.lastInsertRowid);
}

function insertReceipt(database: DatabaseSync, commandId: string, result: unknown): void {
  const sequence = Number(
    database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events").get()?.sequence,
  );
  database
    .prepare(
      `INSERT INTO orchestration_command_receipts (
        command_id, accepted_at, first_sequence, last_sequence, result_json
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(commandId, "created", sequence, sequence, JSON.stringify(result));
}

function readReceipt(database: DatabaseSync, commandId: string): string | undefined {
  const row = databaseRow(
    database.prepare("SELECT result_json FROM orchestration_command_receipts WHERE command_id = ?").get(commandId),
  );
  return row ? requiredStringColumn(row, "result_json") : undefined;
}

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projection_channel_messages (message_id TEXT PRIMARY KEY, message_json TEXT NOT NULL);
    CREATE TABLE projection_channel_reads (
      channel_id TEXT NOT NULL, member_id TEXT NOT NULL, through_sequence INTEGER NOT NULL,
      PRIMARY KEY(channel_id, member_id)
    );
    CREATE TABLE projection_thread_reads (
      thread_id TEXT NOT NULL, member_id TEXT NOT NULL, through_message_id TEXT,
      PRIMARY KEY(thread_id, member_id)
    );
    CREATE TABLE projection_thread_messages (message_json TEXT NOT NULL);
    CREATE TABLE projection_direct_threads (
      thread_id TEXT PRIMARY KEY, member_a_id TEXT NOT NULL, member_b_id TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_id TEXT,
      last_event_sequence INTEGER NOT NULL, UNIQUE(member_a_id, member_b_id)
    );
    CREATE TABLE projection_direct_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES projection_direct_threads(thread_id),
      sender_member_id TEXT NOT NULL, recipient_member_id TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, message_json TEXT NOT NULL, last_event_sequence INTEGER NOT NULL
    );
    CREATE TABLE projection_direct_reads (
      thread_id TEXT NOT NULL REFERENCES projection_direct_threads(thread_id),
      member_id TEXT NOT NULL, last_read_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(thread_id, member_id)
    );
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      command_id TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
    );
    CREATE TABLE orchestration_command_receipts (
      command_id TEXT PRIMARY KEY,
      accepted_at TEXT NOT NULL,
      first_sequence INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      result_json TEXT NOT NULL CHECK(json_valid(result_json))
    );
  `);
  return db;
}
