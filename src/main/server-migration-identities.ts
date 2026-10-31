import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ChannelMessage,
  type ConversationMessage,
  isChannelMessage,
  isConversationMessage,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { TeamProtocolV1JsonObject, TeamProtocolV1JsonValue } from "@openbot/contracts/team-protocol/v1";
import {
  databaseRow,
  databaseRows,
  requiredNumberColumn,
  requiredStringColumn,
} from "../backend/database/database-rows";

type MigrationDatabase = Pick<DatabaseSync, "exec" | "prepare">;

type DirectThreadRow = {
  thread_id: string;
  member_a_id: string;
  member_b_id: string;
};

type ReadRow = {
  thread_id: string;
  member_id: string;
};

type EventRow = {
  row_id: number;
  event_id: string;
  command_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload_json: string;
  sequence: number;
};

type EventRewrite = {
  rowId: number;
  aggregateId: string;
  payloadJson: string;
};

type CommandRewrite = {
  nextCommandId: string;
  receiptResultJson?: string;
};

/**
 * Rewrites collaboration member references when a migrated database is attached to a different
 * host identity directory. This deliberately touches only known identity columns and JSON keys;
 * free-form message text and unrelated IDs remain unchanged.
 *
 * If the mapping would merge two unique read cursors or direct conversations, the operation
 * fails and rolls back. The caller must resolve that ambiguity before activating the migration.
 */
export function remapMigratedMemberIdentities(
  database: MigrationDatabase,
  memberIdMap: ReadonlyMap<string, string>,
): void {
  const mapping = new Map<string, string>();
  for (const [source, target] of memberIdMap) {
    if (!source || !target) throw new Error("Migrated member IDs must be non-empty.");
    if (source !== target) mapping.set(source, target);
  }
  if (mapping.size === 0) return;

  assertSchema(database);
  const mapId = (id: string): string => mapping.get(id) ?? id;
  const directThreads = databaseRows(
    database.prepare("SELECT thread_id, member_a_id, member_b_id FROM projection_direct_threads").all(),
  ).map((value) => {
    const row = databaseRow(value);
    if (!row) throw new Error("Invalid direct thread row.");
    return {
      thread_id: requiredStringColumn(row, "thread_id"),
      member_a_id: requiredStringColumn(row, "member_a_id"),
      member_b_id: requiredStringColumn(row, "member_b_id"),
    };
  });
  const directMessages = databaseRows(
    database
      .prepare(
        "SELECT message_id, thread_id, sender_member_id, recipient_member_id, message_json FROM projection_direct_messages",
      )
      .all(),
  ).map((value) => {
    const row = databaseRow(value);
    if (!row) throw new Error("Invalid direct message row.");
    return {
      message_id: requiredStringColumn(row, "message_id"),
      thread_id: requiredStringColumn(row, "thread_id"),
      sender_member_id: requiredStringColumn(row, "sender_member_id"),
      recipient_member_id: requiredStringColumn(row, "recipient_member_id"),
      message_json: requiredStringColumn(row, "message_json"),
    };
  });

  const directThreadIds = new Map<string, string>();
  const changedThreads = new Map<string, { temporaryId: string; memberA: string; memberB: string; threadId: string }>();
  for (const row of directThreads) {
    const [memberA, memberB] = sortedMemberIds(mapId(row.member_a_id), mapId(row.member_b_id));
    if (memberA === memberB) throw new Error("Member remapping cannot create a direct conversation with oneself.");
    const threadId = directThreadId(memberA, memberB);
    if (memberA !== row.member_a_id || memberB !== row.member_b_id || threadId !== row.thread_id) {
      changedThreads.set(row.thread_id, { temporaryId: temporaryId("thread"), memberA, memberB, threadId });
      directThreadIds.set(row.thread_id, threadId);
    }
  }

  // A direct message must have its parent projection row. Do not guess how to repair a partial import.
  const directThreadRowIds = new Set(directThreads.map((row) => row.thread_id));
  for (const row of directMessages) {
    if (!directThreadRowIds.has(row.thread_id)) {
      throw new Error("Member remapping cannot safely update an orphaned direct conversation.");
    }
    const [sender, recipient] = [mapId(row.sender_member_id), mapId(row.recipient_member_id)];
    if (sender === recipient && (sender !== row.sender_member_id || recipient !== row.recipient_member_id)) {
      throw new Error("Member remapping cannot create a direct conversation with oneself.");
    }
    if (sender !== row.sender_member_id || recipient !== row.recipient_member_id) {
      directThreadIds.set(row.thread_id, directThreadId(sender, recipient));
    }
  }
  assertNoDirectThreadCollisions(directThreads, changedThreads, directThreadIds);

  const channelReads = readRows(database, "projection_channel_reads");
  const threadReads = readRows(database, "projection_thread_reads");
  const directReads = readRows(database, "projection_direct_reads");
  assertNoReadCursorCollisions(channelReads, (row) => `${row.thread_id}\0${mapId(row.member_id)}`, "channel");
  assertNoReadCursorCollisions(threadReads, (row) => `${row.thread_id}\0${mapId(row.member_id)}`, "thread");
  assertNoReadCursorCollisions(
    directReads,
    (row) => `${directThreadIds.get(row.thread_id) ?? row.thread_id}\0${mapId(row.member_id)}`,
    "direct",
  );

  const eventRows = readEventRows(database);
  const { eventRewrites, commandRewrites } = planEventRewrites(
    eventRows,
    database,
    mapId,
    directThreads,
    directThreadIds,
    mapping,
  );
  assertNoEventAggregateCollisions(eventRows, eventRewrites);
  assertNoCommandIdCollisions(database, eventRows, commandRewrites);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("PRAGMA defer_foreign_keys = ON");
    const updateParentThread = database.prepare(
      "UPDATE projection_direct_threads SET thread_id = ? WHERE thread_id = ?",
    );
    const updateMessageThread = database.prepare(
      "UPDATE projection_direct_messages SET thread_id = ? WHERE thread_id = ?",
    );
    const updateReadThread = database.prepare("UPDATE projection_direct_reads SET thread_id = ? WHERE thread_id = ?");

    // Move identity columns through unique temporary IDs so a two-way ID swap cannot hit a
    // transient UNIQUE constraint. The temporary values exist only inside this transaction.
    const temporaryMembers = new Map<string, string>();
    const tempMember = (id: string): string => {
      let temporary = temporaryMembers.get(id);
      if (!temporary) {
        temporary = temporaryId("member");
        temporaryMembers.set(id, temporary);
      }
      return temporary;
    };
    for (const row of channelReads) {
      const target = mapId(row.member_id);
      if (target !== row.member_id) updateReadMember(database, "projection_channel_reads", row, tempMember(target));
    }
    for (const row of threadReads) {
      const target = mapId(row.member_id);
      if (target !== row.member_id) updateReadMember(database, "projection_thread_reads", row, tempMember(target));
    }
    for (const row of directReads) {
      const target = mapId(row.member_id);
      if (target !== row.member_id) updateReadMember(database, "projection_direct_reads", row, tempMember(target));
    }

    const updateDirectThreadMembers = database.prepare(
      "UPDATE projection_direct_threads SET member_a_id = ?, member_b_id = ? WHERE thread_id = ?",
    );
    const updateDirectMessageMembers = database.prepare(
      "UPDATE projection_direct_messages SET sender_member_id = ?, recipient_member_id = ? WHERE message_id = ?",
    );
    for (const row of directMessages) {
      const sender = mapId(row.sender_member_id);
      const recipient = mapId(row.recipient_member_id);
      if (sender !== row.sender_member_id || recipient !== row.recipient_member_id) {
        updateDirectMessageMembers.run(tempMember(sender), tempMember(recipient), row.message_id);
      }
    }

    for (const [oldId, value] of changedThreads) {
      updateParentThread.run(value.temporaryId, oldId);
      updateMessageThread.run(value.temporaryId, oldId);
      updateReadThread.run(value.temporaryId, oldId);
    }
    for (const [oldId, value] of changedThreads) {
      const row = directThreads.find((candidate) => candidate.thread_id === oldId);
      if (!row) continue;
      updateDirectThreadMembers.run(
        tempMember(mapId(row.member_a_id)),
        tempMember(mapId(row.member_b_id)),
        value.temporaryId,
      );
    }

    for (const value of changedThreads.values()) {
      updateParentThread.run(value.threadId, value.temporaryId);
      updateMessageThread.run(value.threadId, value.temporaryId);
      updateReadThread.run(value.threadId, value.temporaryId);
      updateDirectThreadMembers.run(value.memberA, value.memberB, value.threadId);
    }
    for (const row of directMessages) {
      const sender = mapId(row.sender_member_id);
      const recipient = mapId(row.recipient_member_id);
      if (sender !== row.sender_member_id || recipient !== row.recipient_member_id) {
        updateDirectMessageMembers.run(sender, recipient, row.message_id);
      }
    }
    updateReadMembersToTargets(database, channelReads, mapId, "projection_channel_reads", temporaryMembers);
    updateReadMembersToTargets(database, threadReads, mapId, "projection_thread_reads", temporaryMembers);
    updateReadMembersToTargets(
      database,
      directReads,
      mapId,
      "projection_direct_reads",
      temporaryMembers,
      directThreadIds,
    );

    rewriteJsonColumn(database, "projection_channel_messages", "message_json", (value) =>
      rewriteMemberJson(value, mapId),
    );
    rewriteJsonColumn(database, "projection_thread_messages", "message_json", (value) =>
      rewriteThreadProjectionMessage(value, mapId),
    );
    rewriteJsonColumn(database, "projection_direct_messages", "message_json", (value) =>
      rewriteMemberJson(value, mapId, directThreadIds),
    );
    rewriteCommandIds(database, commandRewrites);
    const updateEvent = database.prepare(
      "UPDATE orchestration_events SET aggregate_id = ?, payload_json = ? WHERE rowid = ?",
    );
    for (const event of eventRewrites) {
      updateEvent.run(event.aggregateId, event.payloadJson, event.rowId);
    }
    const updateReceiptResult = database.prepare(
      "UPDATE orchestration_command_receipts SET result_json = ? WHERE command_id = ?",
    );
    for (const rewrite of commandRewrites.values()) {
      if (rewrite.receiptResultJson !== undefined) {
        updateReceiptResult.run(rewrite.receiptResultJson, rewrite.nextCommandId);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Keep the original failure. SQLite already reports a closed or invalid transaction.
    }
    throw error;
  }
}

function assertSchema(database: MigrationDatabase): void {
  const required: Record<string, string[]> = {
    projection_channel_messages: ["message_json"],
    projection_channel_reads: ["channel_id", "member_id", "through_sequence"],
    projection_thread_messages: ["message_json"],
    projection_thread_reads: ["thread_id", "member_id", "through_message_id"],
    projection_direct_threads: ["thread_id", "member_a_id", "member_b_id"],
    projection_direct_messages: ["message_id", "thread_id", "sender_member_id", "recipient_member_id", "message_json"],
    projection_direct_reads: ["thread_id", "member_id"],
    orchestration_events: [
      "event_id",
      "command_id",
      "aggregate_type",
      "aggregate_id",
      "event_type",
      "sequence",
      "payload_json",
    ],
    orchestration_command_receipts: ["command_id", "accepted_at", "first_sequence", "last_sequence", "result_json"],
  };
  for (const [table, columns] of Object.entries(required)) {
    const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) throw new Error(`Migration identity remap requires table ${table}.`);
    const actual = new Set(
      databaseRows(database.prepare(`PRAGMA table_info(${table})`).all()).map((column) =>
        requiredStringColumn(column, "name"),
      ),
    );
    const missing = columns.filter((column) => !actual.has(column));
    if (missing.length) throw new Error(`Migration identity remap requires ${table}.${missing.join(", ")}.`);
  }
}

function readEventRows(database: MigrationDatabase): EventRow[] {
  return databaseRows(
    database
      .prepare(
        `SELECT rowid AS row_id, event_id, command_id, aggregate_type, aggregate_id, event_type, payload_json, sequence
         FROM orchestration_events ORDER BY sequence`,
      )
      .all(),
  ).map((value) => {
    const row = databaseRow(value);
    if (!row) throw new Error("Invalid orchestration event row.");
    return {
      row_id: requiredNumberColumn(row, "row_id"),
      event_id: requiredStringColumn(row, "event_id"),
      command_id: requiredStringColumn(row, "command_id"),
      aggregate_type: requiredStringColumn(row, "aggregate_type"),
      aggregate_id: requiredStringColumn(row, "aggregate_id"),
      event_type: requiredStringColumn(row, "event_type"),
      payload_json: requiredStringColumn(row, "payload_json"),
      sequence: requiredNumberColumn(row, "sequence"),
    };
  });
}

function planEventRewrites(
  rows: EventRow[],
  database: MigrationDatabase,
  mapId: (id: string) => string,
  directThreads: DirectThreadRow[],
  directThreadIds: Map<string, string>,
  mapping: Map<string, string>,
): { eventRewrites: EventRewrite[]; commandRewrites: Map<string, CommandRewrite> } {
  const directThreadsById = new Map(directThreads.map((thread) => [thread.thread_id, thread]));
  const commandRewrites = new Map<string, CommandRewrite>();
  const eventRewrites: EventRewrite[] = [];

  const addCommandRewrite = (oldCommandId: string, nextCommandId: string, receiptResultJson?: string): void => {
    const previous = commandRewrites.get(oldCommandId);
    if (previous && (previous.nextCommandId !== nextCommandId || previous.receiptResultJson !== receiptResultJson)) {
      throw new Error("Member remapping produced inconsistent command receipt updates.");
    }
    commandRewrites.set(oldCommandId, {
      nextCommandId,
      ...(receiptResultJson === undefined ? {} : { receiptResultJson }),
    });
  };

  for (const row of rows) {
    let aggregateId = row.aggregate_id;
    let payloadJson = row.payload_json;
    let commandId: string | null = null;

    if (row.event_type === "direct-message.sent") {
      if (row.aggregate_type !== "direct-thread")
        throw new Error("Direct-message event has an invalid aggregate type.");
      const payload = jsonObject(row.payload_json, "direct-message event");
      const id = jsonString(payload, "id", "direct-message event");
      const threadId = jsonString(payload, "threadId", "direct-message event");
      const sender = jsonString(payload, "senderMemberId", "direct-message event");
      const recipient = jsonString(payload, "recipientMemberId", "direct-message event");
      jsonString(payload, "text", "direct-message event");
      jsonString(payload, "createdAt", "direct-message event");
      jsonInteger(payload, "sequence", "direct-message event");
      const oldThreadId = directThreadId(sender, recipient);
      const thread = directThreadsById.get(oldThreadId);
      if (
        sender === recipient ||
        threadId !== oldThreadId ||
        row.aggregate_id !== oldThreadId ||
        !thread ||
        !sameMemberPair(thread.member_a_id, thread.member_b_id, sender, recipient)
      ) {
        throw new Error("Direct-message event identity references are inconsistent.");
      }
      const oldCommandId = `direct-message:${sender}:${id}`;
      if (row.command_id !== oldCommandId) throw new Error("Direct-message command ID does not match its payload.");
      const nextSender = mapId(sender);
      const nextRecipient = mapId(recipient);
      if (nextSender === nextRecipient) {
        throw new Error("Member remapping cannot create a direct conversation with oneself.");
      }
      const nextThreadId = directThreadId(nextSender, nextRecipient);
      const projectedThreadId = directThreadIds.get(oldThreadId) ?? oldThreadId;
      if (projectedThreadId !== nextThreadId) {
        throw new Error("Direct-message event does not match the remapped direct-thread projection.");
      }
      aggregateId = nextThreadId;
      if (threadId !== nextThreadId || sender !== nextSender || recipient !== nextRecipient) {
        payloadJson = JSON.stringify({
          ...payload,
          threadId: nextThreadId,
          senderMemberId: nextSender,
          recipientMemberId: nextRecipient,
        });
      }
      commandId = `direct-message:${nextSender}:${id}`;
      const receiptResultJson = rewriteDirectMessageReceipt(
        database,
        oldCommandId,
        {
          id,
          threadId: oldThreadId,
          senderMemberId: sender,
          recipientMemberId: recipient,
          text: jsonString(payload, "text", "direct-message event"),
          createdAt: jsonString(payload, "createdAt", "direct-message event"),
          sequence: row.sequence,
        },
        { threadId: nextThreadId, senderMemberId: nextSender, recipientMemberId: nextRecipient },
      );
      addCommandRewrite(oldCommandId, commandId, receiptResultJson);
    } else if (row.event_type === "direct-thread.read") {
      if (row.aggregate_type !== "direct-thread") throw new Error("Direct-read event has an invalid aggregate type.");
      const payload = jsonObject(row.payload_json, "direct-read event");
      const memberId = jsonString(payload, "memberId", "direct-read event");
      const throughSequence = jsonInteger(payload, "throughSequence", "direct-read event");
      const thread = directThreadsById.get(row.aggregate_id);
      if (!thread || (thread.member_a_id !== memberId && thread.member_b_id !== memberId)) {
        throw new Error("Direct-read event identity references are inconsistent.");
      }
      const oldCommandId = `direct-read:${row.aggregate_id}:${memberId}:${throughSequence}`;
      if (row.command_id !== oldCommandId) throw new Error("Direct-read command ID does not match its payload.");
      const nextMemberId = mapId(memberId);
      const nextOtherMemberId = mapId(thread.member_a_id === memberId ? thread.member_b_id : thread.member_a_id);
      if (nextMemberId === nextOtherMemberId) {
        throw new Error("Member remapping cannot create a direct conversation with oneself.");
      }
      aggregateId = directThreadId(nextMemberId, nextOtherMemberId);
      const projectedThreadId = directThreadIds.get(row.aggregate_id) ?? row.aggregate_id;
      if (projectedThreadId !== aggregateId) {
        throw new Error("Direct-read event does not match the remapped direct-thread projection.");
      }
      if (memberId !== nextMemberId) payloadJson = JSON.stringify({ ...payload, memberId: nextMemberId });
      commandId = `direct-read:${aggregateId}:${nextMemberId}:${throughSequence}`;
      assertNullReceipt(database, oldCommandId, "Direct-read");
      addCommandRewrite(oldCommandId, commandId);
    } else if (row.aggregate_type === "thread-read" || row.event_type.startsWith("thread-read.")) {
      if (row.aggregate_type !== "thread-read") throw new Error("Thread-read event has an invalid aggregate type.");
      const event =
        row.event_type === "thread-read.initialized"
          ? "initialized"
          : row.event_type === "thread-read.marked"
            ? "marked"
            : null;
      if (!event) throw new Error(`Unsupported thread-read event type: ${row.event_type}.`);
      const payload = jsonObject(row.payload_json, "thread-read event");
      const threadId = jsonString(payload, "threadId", "thread-read event");
      const memberId = jsonString(payload, "memberId", "thread-read event");
      if (!(payload.throughMessageId === null || typeof payload.throughMessageId === "string")) {
        throw new Error("Thread-read event cursor is invalid.");
      }
      if (row.aggregate_id !== `${threadId}:${memberId}`) {
        throw new Error("Thread-read aggregate ID does not match its payload.");
      }
      const prefix = `thread-read:${event}:${threadId}:${memberId}:`;
      if (!row.command_id.startsWith(prefix) || row.command_id.length === prefix.length) {
        throw new Error("Thread-read command ID does not match its payload.");
      }
      const nextMemberId = mapId(memberId);
      aggregateId = `${threadId}:${nextMemberId}`;
      if (memberId !== nextMemberId) payloadJson = JSON.stringify({ ...payload, memberId: nextMemberId });
      commandId = `thread-read:${event}:${threadId}:${nextMemberId}:${row.command_id.slice(prefix.length)}`;
      assertNullReceipt(database, row.command_id, "Thread-read");
      addCommandRewrite(row.command_id, commandId);
    } else if (row.event_type === "channel.read") {
      if (row.aggregate_type !== "channel") throw new Error("Channel-read event has an invalid aggregate type.");
      const payload = jsonObject(row.payload_json, "channel-read event");
      const memberId = jsonString(payload, "memberId", "channel-read event");
      jsonInteger(payload, "throughSequence", "channel-read event");
      const prefix = `channel-read:${memberId}:`;
      if (!row.command_id.startsWith(prefix) || row.command_id.length === prefix.length) {
        throw new Error("Channel-read command ID does not match its payload.");
      }
      const nextMemberId = mapId(memberId);
      if (memberId !== nextMemberId) payloadJson = JSON.stringify({ ...payload, memberId: nextMemberId });
      commandId = `channel-read:${nextMemberId}:${row.command_id.slice(prefix.length)}`;
      aggregateId = row.aggregate_id;
    } else if (row.event_type === "channel.changed") {
      if (row.aggregate_type !== "channel") throw new Error("Channel-change event has an invalid aggregate type.");
      const payload = jsonObject(row.payload_json, "channel-change event");
      if (!Array.isArray(payload.messages)) throw new Error("Channel-change event messages are invalid.");
      let messagesChanged = false;
      const messages = payload.messages.map((value) => {
        const message = requireChannelMessage(value);
        const authorId = message.author.kind === "member" ? mapId(message.author.id) : message.author.id;
        const authorIdentityId =
          message.author.kind === "member" && message.author.identityId !== undefined
            ? mapId(message.author.identityId)
            : message.author.identityId;
        const senderMember = message.message.senderMember;
        const senderMemberId = senderMember ? mapId(senderMember.id) : undefined;
        if (
          authorId === message.author.id &&
          authorIdentityId === message.author.identityId &&
          senderMemberId === senderMember?.id
        ) {
          return toTeamProtocolV1JsonValue(message);
        }
        messagesChanged = true;
        return toTeamProtocolV1JsonValue({
          ...message,
          author: {
            ...message.author,
            ...(message.author.kind === "member" ? { id: authorId } : {}),
            ...(authorIdentityId === undefined || message.author.kind !== "member"
              ? {}
              : { identityId: authorIdentityId }),
          },
          message:
            senderMember && senderMemberId !== senderMember.id
              ? { ...message.message, senderMember: { ...senderMember, id: senderMemberId } }
              : message.message,
        });
      });
      if (messagesChanged) payloadJson = JSON.stringify({ ...payload, messages });
      aggregateId = row.aggregate_id;
      const nextCommandId = rewriteChannelCommandId(row.command_id, mapping);
      if (nextCommandId !== row.command_id) commandId = nextCommandId;
    } else if (row.aggregate_type === "thread") {
      // ConversationWriter uses only these top-level message slots. Do not recurse into `detail`
      // or arbitrary thread event data, which can contain user-authored text and opaque IDs.
      payloadJson = rewriteThreadEventPayload(row.payload_json, mapId);
    } else if (row.aggregate_type === "direct-thread" && directThreadIds.has(row.aggregate_id)) {
      // A newly introduced direct-thread event may carry member IDs in an unknown payload shape.
      // Keep migration atomic and require an explicit typed rule instead of guessing recursively.
      throw new Error(`Unsupported direct-thread event type during identity remapping: ${row.event_type}.`);
    }

    if (
      aggregateId !== row.aggregate_id ||
      payloadJson !== row.payload_json ||
      (commandId !== null && commandId !== row.command_id)
    ) {
      eventRewrites.push({
        rowId: row.row_id,
        aggregateId,
        payloadJson,
      });
    }
    if (commandId !== null && commandId !== row.command_id) {
      const current = commandRewrites.get(row.command_id);
      addCommandRewrite(row.command_id, commandId, current?.receiptResultJson);
    }
  }

  return { eventRewrites, commandRewrites };
}

function jsonObject(json: string, label: string): TeamProtocolV1JsonObject {
  const value = JSON.parse(json);
  if (!isTeamProtocolV1JsonObject(value)) throw new Error(`${label} payload is not an object.`);
  return value;
}

function isTeamProtocolV1JsonObject(value: unknown): value is TeamProtocolV1JsonObject {
  return isDynamicRecord(value) && Object.values(value).every(isTeamProtocolV1JsonValue);
}

function isTeamProtocolV1JsonValue(value: unknown): value is TeamProtocolV1JsonValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isTeamProtocolV1JsonValue)) ||
    isTeamProtocolV1JsonObject(value)
  );
}

function jsonString(record: TeamProtocolV1JsonObject, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${label} field ${key} is invalid.`);
  return value;
}

function jsonInteger(record: TeamProtocolV1JsonObject, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} field ${key} is invalid.`);
  }
  return value;
}

function rewriteThreadEventPayload(json: string, mapId: (id: string) => string): string {
  const payload = jsonObject(json, "thread event");
  let result = payload;
  let changed = false;

  if ("snapshot" in payload) {
    if (!isDynamicRecord(payload.snapshot) || !Array.isArray(payload.snapshot.messages)) {
      throw new Error("Thread snapshot event messages are invalid.");
    }
    const messages = payload.snapshot.messages.map((message) => {
      if (!isConversationMessage(message)) throw new Error("Thread snapshot event message is invalid.");
      const rewritten = rewriteConversationMessageSender(message, mapId);
      if (rewritten !== message) changed = true;
      return toTeamProtocolV1JsonValue(rewritten);
    });
    if (changed) result = { ...result, snapshot: { ...payload.snapshot, messages } };
  }

  for (const key of ["appendedMessage", "streamedMessage"] as const) {
    if (!(key in payload)) continue;
    const message = payload[key];
    if (!isConversationMessage(message)) throw new Error(`Thread event ${key} is invalid.`);
    const rewritten = rewriteConversationMessageSender(message, mapId);
    if (rewritten !== message) {
      result = { ...result, [key]: toTeamProtocolV1JsonValue(rewritten) };
      changed = true;
    }
  }

  return changed ? JSON.stringify(result) : json;
}

function requireChannelMessage(value: TeamProtocolV1JsonValue): ChannelMessage {
  if (!isChannelMessage(value)) throw new Error("Channel-change event message is invalid.");
  return value;
}

function toTeamProtocolV1JsonValue(value: unknown): TeamProtocolV1JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toTeamProtocolV1JsonValue);
  if (!isDynamicRecord(value)) throw new Error("An event value is not valid JSON data.");
  const result: TeamProtocolV1JsonObject = {};
  for (const [key, item] of Object.entries(value)) result[key] = toTeamProtocolV1JsonValue(item);
  return result;
}

function rewriteConversationMessageSender(
  message: ConversationMessage,
  mapId: (id: string) => string,
): ConversationMessage {
  const senderMember = message.senderMember;
  if (!senderMember) return message;
  const id = mapId(senderMember.id);
  return id === senderMember.id ? message : { ...message, senderMember: { ...senderMember, id } };
}

function rewriteThreadProjectionMessage(
  value: TeamProtocolV1JsonValue,
  mapId: (id: string) => string,
): TeamProtocolV1JsonValue {
  if (!isConversationMessage(value)) throw new Error("Thread message projection is invalid.");
  const rewritten = rewriteConversationMessageSender(value, mapId);
  return rewritten === value ? value : toTeamProtocolV1JsonValue(rewritten);
}

function rewriteDirectMessageReceipt(
  database: MigrationDatabase,
  commandId: string,
  expected: {
    id: string;
    threadId: string;
    senderMemberId: string;
    recipientMemberId: string;
    text: string;
    createdAt: string;
    sequence: number;
  },
  next: { threadId: string; senderMemberId: string; recipientMemberId: string },
): string | undefined {
  const row = databaseRow(
    database.prepare("SELECT result_json FROM orchestration_command_receipts WHERE command_id = ?").get(commandId),
  );
  if (!row) return undefined;
  const result = jsonObject(requiredStringColumn(row, "result_json"), "direct-message receipt");
  if (
    result.id !== expected.id ||
    result.threadId !== expected.threadId ||
    result.senderMemberId !== expected.senderMemberId ||
    result.recipientMemberId !== expected.recipientMemberId ||
    result.text !== expected.text ||
    result.createdAt !== expected.createdAt ||
    result.sequence !== expected.sequence
  ) {
    throw new Error("Direct-message receipt does not match its event.");
  }
  return JSON.stringify({
    ...result,
    threadId: next.threadId,
    senderMemberId: next.senderMemberId,
    recipientMemberId: next.recipientMemberId,
  });
}

function assertNullReceipt(database: MigrationDatabase, commandId: string, label: string): void {
  const row = databaseRow(
    database.prepare("SELECT result_json FROM orchestration_command_receipts WHERE command_id = ?").get(commandId),
  );
  if (row && requiredStringColumn(row, "result_json") !== "null") {
    throw new Error(`${label} receipt does not match its event.`);
  }
}

function rewriteChannelCommandId(commandId: string, mapping: Map<string, string>): string {
  const matches = [...mapping].filter(([source]) => commandId.startsWith(`channels:${source}:`));
  if (matches.length > 1) throw new Error("Channel command ID has an ambiguous member prefix.");
  const match = matches[0];
  if (!match) return commandId;
  const [source, target] = match;
  const prefix = `channels:${source}:`;
  if (commandId.length === prefix.length) throw new Error("Channel command ID has no operation suffix.");
  return `channels:${target}:${commandId.slice(prefix.length)}`;
}

function assertNoEventAggregateCollisions(rows: EventRow[], rewrites: EventRewrite[]): void {
  const aggregateChanges = new Map(rewrites.map((rewrite) => [rewrite.rowId, rewrite]));
  const originalsByTarget = new Map<string, Set<string>>();
  for (const row of rows) {
    const aggregateId = aggregateChanges.get(row.row_id)?.aggregateId ?? row.aggregate_id;
    const key = `${row.aggregate_type}\0${aggregateId}`;
    const originals = originalsByTarget.get(key) ?? new Set<string>();
    originals.add(row.aggregate_id);
    originalsByTarget.set(key, originals);
  }
  if ([...originalsByTarget.values()].some((originals) => originals.size > 1)) {
    throw new Error("Member remapping would merge orchestration event aggregates.");
  }
}

function assertNoCommandIdCollisions(
  database: MigrationDatabase,
  events: EventRow[],
  rewrites: Map<string, CommandRewrite>,
): void {
  const moving = new Map([...rewrites].filter(([source, value]) => source !== value.nextCommandId));
  const targets = new Set<string>();
  for (const value of moving.values()) {
    if (targets.has(value.nextCommandId)) throw new Error("Member remapping would merge orchestration command IDs.");
    targets.add(value.nextCommandId);
  }
  const eventCommandIds = new Set(events.map((event) => event.command_id));
  const receiptCommandIds = new Set(
    databaseRows(database.prepare("SELECT command_id FROM orchestration_command_receipts").all()).map((value) => {
      const row = databaseRow(value);
      if (!row) throw new Error("Invalid orchestration command receipt.");
      return requiredStringColumn(row, "command_id");
    }),
  );
  for (const [source, value] of moving) {
    const targetIsMoving = moving.has(value.nextCommandId);
    if (!targetIsMoving && (eventCommandIds.has(value.nextCommandId) || receiptCommandIds.has(value.nextCommandId))) {
      throw new Error("Member remapping would overwrite an existing orchestration command receipt.");
    }
    if (!eventCommandIds.has(source) && !receiptCommandIds.has(source)) {
      throw new Error("Member remapping command ID has no event or receipt.");
    }
  }
}

function rewriteCommandIds(database: MigrationDatabase, rewrites: Map<string, CommandRewrite>): void {
  const moving = [...rewrites].filter(([source, value]) => source !== value.nextCommandId);
  if (moving.length === 0) return;
  const existing = new Set(
    databaseRows(database.prepare("SELECT command_id FROM orchestration_command_receipts").all()).map((value) => {
      const row = databaseRow(value);
      if (!row) throw new Error("Invalid orchestration command receipt.");
      return requiredStringColumn(row, "command_id");
    }),
  );
  for (const row of databaseRows(database.prepare("SELECT command_id FROM orchestration_events").all())) {
    const value = databaseRow(row);
    if (!value) throw new Error("Invalid orchestration event row.");
    existing.add(requiredStringColumn(value, "command_id"));
  }
  const temporary = new Map<string, string>();
  for (const [source] of moving) {
    let next = temporaryId("command");
    while (existing.has(next)) next = temporaryId("command");
    temporary.set(source, next);
    existing.add(next);
  }
  const updateEvents = database.prepare("UPDATE orchestration_events SET command_id = ? WHERE command_id = ?");
  const updateReceipts = database.prepare(
    "UPDATE orchestration_command_receipts SET command_id = ? WHERE command_id = ?",
  );
  for (const [source, temp] of temporary) {
    updateEvents.run(temp, source);
    updateReceipts.run(temp, source);
  }
  for (const [source, value] of moving) {
    const temp = temporary.get(source);
    if (!temp) throw new Error("The temporary command remap was not recorded.");
    updateEvents.run(value.nextCommandId, temp);
    updateReceipts.run(value.nextCommandId, temp);
  }
}

function sameMemberPair(leftA: string, leftB: string, rightA: string, rightB: string): boolean {
  return (leftA === rightA && leftB === rightB) || (leftA === rightB && leftB === rightA);
}

function readRows(database: MigrationDatabase, table: string): ReadRow[] {
  const rows =
    table === "projection_channel_reads"
      ? database.prepare("SELECT channel_id AS thread_id, member_id FROM projection_channel_reads").all()
      : database.prepare(`SELECT thread_id, member_id FROM ${table}`).all();
  return databaseRows(rows).map((value) => {
    const row = databaseRow(value);
    if (!row) throw new Error(`Invalid ${table} row.`);
    return {
      thread_id: requiredStringColumn(row, "thread_id"),
      member_id: requiredStringColumn(row, "member_id"),
    };
  });
}

function updateReadMember(database: MigrationDatabase, table: string, row: ReadRow, memberId: string): void {
  if (table === "projection_channel_reads") {
    database
      .prepare("UPDATE projection_channel_reads SET member_id = ? WHERE channel_id = ? AND member_id = ?")
      .run(memberId, row.thread_id, row.member_id);
  } else {
    database
      .prepare(`UPDATE ${table} SET member_id = ? WHERE thread_id = ? AND member_id = ?`)
      .run(memberId, row.thread_id, row.member_id);
  }
}

function updateReadMembersToTargets(
  database: MigrationDatabase,
  rows: ReadRow[],
  mapId: (id: string) => string,
  table: string,
  temporaryMembers: Map<string, string>,
  threadIds = new Map<string, string>(),
): void {
  for (const row of rows) {
    const target = mapId(row.member_id);
    if (target === row.member_id) continue;
    const temporary = temporaryMembers.get(target);
    if (!temporary) throw new Error("The temporary member remap was not recorded.");
    const threadId = threadIds.get(row.thread_id) ?? row.thread_id;
    updateReadMember(database, table, { ...row, thread_id: threadId, member_id: temporary }, target);
  }
}

function rewriteJsonColumn(
  database: MigrationDatabase,
  table: string,
  column: string,
  rewrite: (value: TeamProtocolV1JsonValue) => TeamProtocolV1JsonValue,
): void {
  const rows = databaseRows(
    database.prepare(`SELECT rowid AS row_id, ${column} AS json_value FROM ${table}`).all(),
  ).map((value) => {
    const row = databaseRow(value);
    if (!row) throw new Error(`Invalid ${table} JSON row.`);
    return {
      row_id: requiredNumberColumn(row, "row_id"),
      json_value: requiredStringColumn(row, "json_value"),
    };
  });
  const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
  for (const row of rows) {
    const before: TeamProtocolV1JsonValue = JSON.parse(row.json_value);
    const after = rewrite(before);
    const serialized = JSON.stringify(after);
    if (serialized !== row.json_value) update.run(serialized, row.row_id);
  }
}

function rewriteMemberJson(
  value: TeamProtocolV1JsonValue,
  mapId: (id: string) => string,
  threadIds = new Map<string, string>(),
  memberIdentityContext = false,
): TeamProtocolV1JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => rewriteMemberJson(item, mapId, threadIds, memberIdentityContext));
  const record = value;
  const isDirectMessage =
    (typeof record.senderMemberId === "string" && typeof record.recipientMemberId === "string") ||
    (typeof record.sender_member_id === "string" && typeof record.recipient_member_id === "string");
  const result: TeamProtocolV1JsonObject = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      if (MEMBER_ID_KEYS.has(key) || (key === "id" && (memberIdentityContext || record.kind === "member"))) {
        result[key] = mapId(item);
        continue;
      }
      if (key === "threadId" || key === "thread_id") {
        const memberThread = isDirectMessage ? computeDirectThreadFromJson(record, mapId) : threadIds.get(item);
        result[key] = memberThread ?? item;
        continue;
      }
      result[key] = item;
      continue;
    }
    const childIsMemberIdentity =
      key === "senderMember" || key === "recipientMember" || (memberIdentityContext && key === "identity");
    result[key] = rewriteMemberJson(item, mapId, threadIds, childIsMemberIdentity);
  }
  return result;
}

const MEMBER_ID_KEYS = new Set([
  "memberId",
  "member_id",
  "senderMemberId",
  "sender_member_id",
  "recipientMemberId",
  "recipient_member_id",
  "memberAId",
  "memberBId",
  "member_a_id",
  "member_b_id",
  "identityId",
  "identity_id",
]);

function computeDirectThreadFromJson(record: TeamProtocolV1JsonObject, mapId: (id: string) => string): string | null {
  const sender = record.senderMemberId ?? record.sender_member_id;
  const recipient = record.recipientMemberId ?? record.recipient_member_id;
  return typeof sender === "string" && typeof recipient === "string"
    ? directThreadId(mapId(sender), mapId(recipient))
    : null;
}

function assertNoDirectThreadCollisions(
  rows: DirectThreadRow[],
  changed: Map<string, { temporaryId: string; memberA: string; memberB: string; threadId: string }>,
  newIds: Map<string, string>,
): void {
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const row of rows) {
    const threadId = newIds.get(row.thread_id) ?? row.thread_id;
    const memberA = changed.get(row.thread_id)?.memberA ?? row.member_a_id;
    const memberB = changed.get(row.thread_id)?.memberB ?? row.member_b_id;
    const pair = `${memberA}\0${memberB}`;
    if (ids.has(threadId) || pairs.has(pair)) {
      throw new Error("Member remapping would merge direct conversations. Resolve the member mapping first.");
    }
    ids.add(threadId);
    pairs.add(pair);
  }
}

function assertNoReadCursorCollisions(rows: ReadRow[], key: (row: ReadRow) => string, kind: string): void {
  const keys = new Set<string>();
  for (const row of rows) {
    const target = key(row);
    if (keys.has(target)) throw new Error(`Member remapping would merge ${kind} read cursors.`);
    keys.add(target);
  }
}

function sortedMemberIds(leftMemberId: string, rightMemberId: string): [string, string] {
  return leftMemberId.localeCompare(rightMemberId) <= 0 ? [leftMemberId, rightMemberId] : [rightMemberId, leftMemberId];
}

function directThreadId(leftMemberId: string, rightMemberId: string): string {
  const [first, second] = sortedMemberIds(leftMemberId, rightMemberId);
  const digest = createHash("sha256").update(`${first}\0${second}`).digest("hex").slice(0, 32);
  return `dm-${digest}`;
}

function temporaryId(kind: string): string {
  return `migration-${kind}:${randomUUID()}`;
}
