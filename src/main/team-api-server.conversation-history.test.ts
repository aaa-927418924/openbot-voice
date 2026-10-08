// @vitest-environment node

import type { AgentSummary } from "@openbot/contracts/ipc";
import {
  CLEAR_CONVERSATION_HISTORY_ROUTE,
  CONVERSATION_HISTORY_DELETE_CAPABILITY,
  DELETE_CONVERSATION_MESSAGE_ROUTE,
} from "@openbot/contracts/team-protocol/conversation-history-delete-v1";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgents, createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

const AGENT: AgentSummary = {
  id: "agent-1",
  provider: "codex",
  name: "Researcher",
  title: "Researcher",
  description: "",
  notifications: true,
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  avatarSeed: "codex",
  avatarHue: null,
  avatarUrl: null,
  threadId: "thread-1",
  workspacePath: "/private/workspace",
  preview: "",
  updatedAt: null,
};

describe("Team API conversation-history-delete-v1", () => {
  it("gates message deletion and per-agent history clearing behind its additive capability", async () => {
    const deleteConversationMessage = vi.fn(() => Effect.void);
    const clearConversationHistory = vi.fn(() => Effect.void);
    const { start, signIn } = await createTeamApiFixture("conversation-history-delete", { configure: true });
    const { base } = await start({
      agents: createAgents({
        listAgents: () => [AGENT],
        deleteConversationMessage,
        clearConversationHistory,
      }),
    });
    const token = await signIn();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      [TEAM_PROTOCOL_VERSION_HEADER]: "6",
      [TEAM_APP_VERSION_HEADER]: "0.30.0",
    };
    const body = { agentId: AGENT.id, messageId: "message-1" };
    const unsupported = await fetch(`${base}${DELETE_CONVERSATION_MESSAGE_ROUTE}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(unsupported.status).toBe(400);
    expect(deleteConversationMessage).not.toHaveBeenCalled();

    const supportedHeaders = { ...headers, [TEAM_CAPABILITIES_HEADER]: CONVERSATION_HISTORY_DELETE_CAPABILITY };
    const deleted = await fetch(`${base}${DELETE_CONVERSATION_MESSAGE_ROUTE}`, {
      method: "POST",
      headers: supportedHeaders,
      body: JSON.stringify(body),
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({});
    expect(deleteConversationMessage).toHaveBeenCalledWith({ agentId: AGENT.id, messageId: body.messageId });

    const cleared = await fetch(`${base}${CLEAR_CONVERSATION_HISTORY_ROUTE}`, {
      method: "POST",
      headers: supportedHeaders,
      body: JSON.stringify({ agentId: AGENT.id }),
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toEqual({});
    expect(clearConversationHistory).toHaveBeenCalledWith(AGENT.id);
  });
});
