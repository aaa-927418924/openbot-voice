// @vitest-environment node

import type { AgentSummary } from "@openbot/contracts/ipc";
import { LIVE_VOICE_CAPABILITY, LIVE_VOICE_ROUTES } from "@openbot/contracts/team-protocol/live-voice-v1";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgents, createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

const CODEX_AGENT: AgentSummary = {
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

describe("Team API live-voice-v1", () => {
  it("requires the capability and routes session start, stop, and text to the host agent", async () => {
    const startLiveVoice = vi.fn((input: { clientSessionId: string }) =>
      Effect.succeed({ sessionId: input.clientSessionId, sdpAnswer: "v=0\r\n" }),
    );
    const stopLiveVoice = vi.fn(() => Effect.void);
    const sendLiveVoiceText = vi.fn(() => Effect.void);
    const { start, signIn } = await createTeamApiFixture("live-voice-routes", { configure: true });
    const { base } = await start({
      agents: createAgents({
        listAgents: () => [CODEX_AGENT],
        startLiveVoice,
        stopLiveVoice,
        sendLiveVoiceText,
      }),
    });
    const token = await signIn();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      [TEAM_PROTOCOL_VERSION_HEADER]: "6",
      [TEAM_APP_VERSION_HEADER]: "0.30.0",
    };
    const withCapability = {
      ...headers,
      [TEAM_CAPABILITIES_HEADER]: LIVE_VOICE_CAPABILITY,
    };

    const compatibility = await fetch(`${base}/v1/compatibility`);
    expect(compatibility.status).toBe(200);
    expect((await compatibility.json()).capabilities).toContain(LIVE_VOICE_CAPABILITY);

    const requestBody = {
      agentId: CODEX_AGENT.id,
      threadId: CODEX_AGENT.threadId,
      clientSessionId: "session-1",
      sdpOffer: "v=0\r\n",
    };
    const unsupported = await fetch(`${base}${LIVE_VOICE_ROUTES.start}`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    expect(unsupported.status).toBe(400);
    expect(startLiveVoice).not.toHaveBeenCalled();

    const started = await fetch(`${base}${LIVE_VOICE_ROUTES.start}`, {
      method: "POST",
      headers: withCapability,
      body: JSON.stringify(requestBody),
    });
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toEqual({ sessionId: "session-1", sdpAnswer: "v=0\r\n" });
    expect(startLiveVoice).toHaveBeenCalledWith(requestBody);

    const session = {
      agentId: CODEX_AGENT.id,
      threadId: CODEX_AGENT.threadId,
      sessionId: "session-1",
    };
    const stopped = await fetch(`${base}${LIVE_VOICE_ROUTES.stop}`, {
      method: "POST",
      headers: withCapability,
      body: JSON.stringify(session),
    });
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toEqual({});
    expect(stopLiveVoice).toHaveBeenCalledWith(session);

    const text = {
      ...session,
      text: "Research this URL: https://example.com",
    };
    const sent = await fetch(`${base}${LIVE_VOICE_ROUTES.sendText}`, {
      method: "POST",
      headers: withCapability,
      body: JSON.stringify(text),
    });
    expect(sent.status).toBe(200);
    await expect(sent.json()).resolves.toEqual({});
    expect(sendLiveVoiceText).toHaveBeenCalledWith(text);
  });

  it("does not let a protocol use an agent it cannot see", async () => {
    const startLiveVoice = vi.fn(() => Effect.succeed({ sessionId: "session-1", sdpAnswer: "v=0\r\n" }));
    const cursorAgent: AgentSummary = { ...CODEX_AGENT, id: "cursor-agent", provider: "cursor" };
    const { start, signIn } = await createTeamApiFixture("live-voice-hidden-agent", { configure: true });
    const { base } = await start({
      agents: createAgents({
        listAgents: () => [CODEX_AGENT, cursorAgent],
        startLiveVoice,
      }),
    });
    const token = await signIn();
    const response = await fetch(`${base}${LIVE_VOICE_ROUTES.start}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        [TEAM_PROTOCOL_VERSION_HEADER]: "5",
        [TEAM_APP_VERSION_HEADER]: "0.30.0",
        [TEAM_CAPABILITIES_HEADER]: LIVE_VOICE_CAPABILITY,
      },
      body: JSON.stringify({
        agentId: cursorAgent.id,
        threadId: cursorAgent.threadId,
        clientSessionId: "session-1",
        sdpOffer: "v=0\r\n",
      }),
    });

    expect(response.status).toBe(404);
    expect(startLiveVoice).not.toHaveBeenCalled();
  });
});
