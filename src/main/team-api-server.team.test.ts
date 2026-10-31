import { Effect } from "effect";
// @vitest-environment node

// Joining, membership, invitations, sessions and passwords: `src/main/team-api/route-team.ts`.

import { EventEmitter } from "node:events";
import type { TeamPresenceSnapshot } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_CHANNEL_IDENTITY_ADMIN_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import {
  TEAM_MEMBER_DEVICE_LINK_CAPABILITY,
  TEAM_MEMBER_DEVICE_LINK_ROUTES,
} from "@openbot/contracts/team-protocol/member-device-link-v1";
import { afterEach, describe, expect, it } from "vitest";
import { OpenBotDatabase } from "../backend/openbot-database";
import { TeamChatStore } from "../backend/team-chat-store";
import {
  createAgents,
  createTeamApiFixture,
  emptyRequest,
  jsonRequest,
  nextJsonEvent,
  nextJsonEvents,
  stopTeamApiFixtures,
} from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

describe("TeamApiServer team", () => {
  it("redeems a one-use device link into a new session for the existing member", async () => {
    const { store, start, signIn } = await createTeamApiFixture("member-device-link", { configure: true });
    const { base } = await start({ agents: createAgents() });
    const protocol = { protocol: 6, appVersion: "0.30.0", capabilities: [TEAM_MEMBER_DEVICE_LINK_CAPABILITY] };
    const ownerToken = await signIn(protocol);
    const ownerId = store.getOwnerMemberId();
    expect(ownerId).toBeTruthy();
    const previousInvite = await Effect.runPromise(store.createInvite("admin"));
    const previousDevice = await Effect.runPromise(
      store.acceptInvite(previousInvite.token, "old-android-device", "a secure device password"),
    );

    const issued = await jsonRequest<{ token: string; expiresAt: string }>(
      base,
      TEAM_MEMBER_DEVICE_LINK_ROUTES.create,
      { token: ownerToken, body: {}, ...protocol },
    );
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now());

    const missingCapability = await fetch(`${base}${TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "OpenBot-Protocol-Version": "6", "OpenBot-App-Version": "0.30.0" },
      body: JSON.stringify({ token: issued.token }),
    });
    expect(missingCapability.status).toBe(404);

    const linked = await jsonRequest<{
      member: { id: string; role: string };
      sessionToken: string;
    }>(base, TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem, {
      token: previousDevice.sessionToken,
      body: { token: issued.token },
      ...protocol,
    });
    expect(linked.member).toEqual({ id: ownerId, role: "owner" });
    expect(store.authenticate(linked.sessionToken)?.id).toBe(ownerId);
    expect(store.listMembers()).toHaveLength(2);
    expect(store.getChannelIdentity(previousDevice.member.id)?.id).toBe(ownerId);

    const replay = await fetch(`${base}${TEAM_MEMBER_DEVICE_LINK_ROUTES.redeem}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OpenBot-Protocol-Version": "6",
        "OpenBot-App-Version": "0.30.0",
        "OpenBot-Capabilities": TEAM_MEMBER_DEVICE_LINK_CAPABILITY,
      },
      body: JSON.stringify({ token: issued.token }),
    });
    expect(replay.status).toBe(400);
  });

  it("limits cross-device channel identity linking to the owner and the advertised capability", async () => {
    const { store, start, signIn } = await createTeamApiFixture("channel-identity", { configure: true });
    const { base } = await start({ agents: createAgents() });
    const ownerToken = await signIn({ protocol: 6, appVersion: "0.30.0" });
    const invite = await Effect.runPromise(store.createInvite("admin"));
    const joined = await jsonRequest<{ member: { id: string }; sessionToken: string }>(base, "/v1/join", {
      body: { inviteToken: invite.token, username: "android-device", password: "a secure team password" },
    });
    const ownerId = store.getOwnerMemberId();
    expect(ownerId).toBeTruthy();
    const capabilityRequest = {
      capabilities: [TEAM_CHANNEL_IDENTITY_ADMIN_CAPABILITY],
      protocol: 6,
      appVersion: "0.30.0",
    };

    const visibleMembers = await jsonRequest<Array<{ id: string; channelIdentityId?: string }>>(
      base,
      TEAM_API_ROUTES.team.members,
      { token: ownerToken, ...capabilityRequest },
    );
    expect(visibleMembers.find((member) => member.id === joined.member.id)?.channelIdentityId).toBe(joined.member.id);

    const linkResponse = await fetch(`${base}${TEAM_API_ROUTES.team.member(joined.member.id)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        "OpenBot-Protocol-Version": "6",
        "OpenBot-App-Version": "0.30.0",
        "OpenBot-Capabilities": TEAM_CHANNEL_IDENTITY_ADMIN_CAPABILITY,
      },
      body: JSON.stringify({ channelIdentityId: ownerId }),
    });
    expect(linkResponse.status, await linkResponse.clone().text()).toBe(200);
    const linked: { id: string; channelIdentityId: string } = await linkResponse.json();
    expect(linked.channelIdentityId).toBe(ownerId);
    expect(store.getChannelIdentity(joined.member.id)?.id).toBe(ownerId);
    expect(store.getMember(joined.member.id)?.id).toBe(joined.member.id);

    const hiddenMembers = await jsonRequest<Array<{ id: string; channelIdentityId?: string | null }>>(
      base,
      TEAM_API_ROUTES.team.members,
      {
        token: ownerToken,
        protocol: 6,
        appVersion: "0.30.0",
        capabilities: [],
      },
    );
    expect(hiddenMembers.find((member) => member.id === joined.member.id)).not.toHaveProperty("channelIdentityId");

    const adminResponse = await fetch(`${base}${TEAM_API_ROUTES.team.member(joined.member.id)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${joined.sessionToken}`,
        "Content-Type": "application/json",
        "OpenBot-Protocol-Version": "6",
        "OpenBot-App-Version": "0.30.0",
        "OpenBot-Capabilities": TEAM_CHANNEL_IDENTITY_ADMIN_CAPABILITY,
      },
      body: JSON.stringify({ channelIdentityId: ownerId }),
    });
    expect(adminResponse.status).toBe(403);

    const unsupportedResponse = await fetch(`${base}${TEAM_API_ROUTES.team.member(joined.member.id)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        "OpenBot-Protocol-Version": "6",
        "OpenBot-App-Version": "0.30.0",
      },
      body: JSON.stringify({ channelIdentityId: null }),
    });
    expect(unsupportedResponse.status).toBe(400);
    expect(store.getChannelIdentity(joined.member.id)?.id).toBe(ownerId);
  });

  it("joins an email-bound invitation with a verified OpenBot account", async () => {
    const { root, store, start } = await createTeamApiFixture("account");
    await Effect.runPromise(
      store.configureWithAccount("Studio Mac", {
        id: "owner-account",
        email: "owner@example.com",
        name: "Owner",
        avatarUrl: null,
      }),
    );
    const invite = await Effect.runPromise(store.createInvite("member", "alice@example.com"));
    const database = new OpenBotDatabase(root);
    await Effect.runPromise(database.initialize());
    const chat = new TeamChatStore(database);
    const agentEvents = new EventEmitter();
    const presenceSnapshots: TeamPresenceSnapshot[] = [];
    const agents = createAgents({}, agentEvents);
    const { port } = await start({
      agents,
      redeemCentralTicket: (ticket, serverId) =>
        Effect.sync(() => {
          if (serverId !== store.getIdentity()?.serverId) return null;
          if (ticket === "valid-team-ticket") {
            return {
              id: "alice-account",
              email: "alice@example.com",
              name: "Alice",
              avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
            };
          }
          return ticket === "owner-team-ticket"
            ? {
                id: "owner-account",
                email: "owner@example.com",
                name: "Owner on another Mac",
                avatarUrl: null,
              }
            : null;
        }),
      onPresence: (snapshot) => presenceSnapshots.push(snapshot),
      chat,
    });

    try {
      const previewResponse = await fetch(`http://127.0.0.1:${port}/v1/invitations/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: invite.token }),
      });
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get("Cache-Control")).toBe("no-store");
      // The frozen Team API projection strips fields released builds never sent, so the
      // wire preview keeps its released shape even though the store knows more.
      await expect(previewResponse.json()).resolves.toEqual({
        role: "member",
        expiresAt: invite.expiresAt,
        emailBound: true,
      });

      const response = await fetch(`http://127.0.0.1:${port}/v1/join/account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inviteToken: invite.token,
          accountTicket: "valid-team-ticket",
        }),
      });
      expect(response.status).toBe(201);
      const joined = await response.json();
      expect(joined.member).toMatchObject({
        email: "alice@example.com",
        role: "member",
        avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
      });
      expect(store.authenticate(joined.sessionToken)?.email).toBe("alice@example.com");

      const usedPreview = await fetch(`http://127.0.0.1:${port}/v1/invitations/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: invite.token }),
      });
      expect(usedPreview.status).toBe(400);

      const ownerInvite = await Effect.runPromise(store.createInvite("member"));
      const ownerResponse = await fetch(`http://127.0.0.1:${port}/v1/join/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inviteToken: ownerInvite.token,
          accountTicket: "owner-team-ticket",
        }),
      });
      expect(ownerResponse.status).toBe(201);
      const ownerConnection = await ownerResponse.json();
      expect(ownerConnection.member).toMatchObject({
        email: "owner@example.com",
        name: "Owner on another Mac",
        role: "owner",
      });
      expect(store.listMembers()).toHaveLength(2);
      expect(store.authenticate(ownerConnection.sessionToken)?.email).toBe("owner@example.com");

      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
        "openbot-events-v2",
        `openbot-token.${joined.sessionToken}`,
      ]);
      const initialEvents = nextJsonEvents(socket, 2);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), {
          once: true,
        });
      });
      const [initialSnapshot, initialPresence] = await initialEvents;
      expect(initialSnapshot).toMatchObject({ type: "runtime-snapshot" });
      expect(initialPresence).toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([
            expect.objectContaining({
              email: "alice@example.com",
              online: true,
              avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
            }),
          ]),
        },
      });

      const typingPresence = nextJsonEvent(socket);
      socket.send(JSON.stringify({ type: "team-typing", botId: "chief", typing: true }));
      await expect(typingPresence).resolves.toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([
            expect.objectContaining({
              email: "alice@example.com",
              online: true,
              typingBotId: "chief",
            }),
          ]),
        },
      });

      const stoppedTypingPresence = nextJsonEvent(socket);
      socket.send(JSON.stringify({ type: "team-typing", botId: null, typing: false }));
      await expect(stoppedTypingPresence).resolves.toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([expect.objectContaining({ email: "alice@example.com", typingBotId: null })]),
        },
      });

      const owner = store.listMembers().find((member) => member.role === "owner");
      expect(owner).toBeDefined();
      const directTypingEvent = nextJsonEvent(socket);
      socket.send(
        JSON.stringify({
          type: "team-direct-typing",
          recipientMemberId: owner?.id,
          typing: true,
        }),
      );
      await expect(directTypingEvent).resolves.toMatchObject({
        type: "team-direct-typing",
        senderMemberId: joined.member.id,
        recipientMemberId: owner?.id,
        typing: true,
      });
      const directMessageEvent = nextJsonEvent(socket);
      const directResponse = await fetch(`http://127.0.0.1:${port}/v1/direct/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${joined.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          memberId: owner?.id,
          clientMessageId: "message-alice-owner",
          text: "Can we review this together?",
        }),
      });
      expect(directResponse.status).toBe(201);
      await expect(directMessageEvent).resolves.toMatchObject({
        type: "team-direct-message",
        message: {
          senderMemberId: joined.member.id,
          recipientMemberId: owner?.id,
          text: "Can we review this together?",
        },
      });
      const threads = await jsonRequest<Array<{ unreadCount: number }>>(
        `http://127.0.0.1:${port}`,
        "/v1/direct/threads",
        { token: joined.sessionToken },
      );
      expect(threads).toMatchObject([{ unreadCount: 0 }]);

      const received = nextJsonEvent(socket);
      agentEvents.emit("event", {
        type: "error",
        code: "smoke_event",
        message: "WebSocket delivery works.",
      });
      await expect(received).resolves.toMatchObject({ type: "error", code: "smoke_event" });
      socket.close();
      await expect
        .poll(() => presenceSnapshots.at(-1)?.members.find((member) => member.email === "alice@example.com")?.online)
        .toBe(false);
    } finally {
      database.close();
    }
  });

  it("does not rate-limit successful account-ticket reconnects, but still limits failed tickets", async () => {
    const account = {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    };
    const nonMember = {
      id: "non-member-account",
      email: "outside@example.com",
      name: "Not a member",
      avatarUrl: null,
    };
    const { store, start } = await createTeamApiFixture("account-ticket-rate-limit");
    await Effect.runPromise(store.configureWithAccount("Linux host", account));
    const consumedTickets = new Set<string>();
    const { base } = await start({
      redeemCentralTicket: (ticket, serverId) =>
        Effect.sync(() => {
          if (
            serverId !== store.getIdentity()?.serverId ||
            (!ticket.startsWith("valid-ticket-") && !ticket.startsWith("non-member-ticket-"))
          )
            return null;
          if (consumedTickets.has(ticket)) return null;
          consumedTickets.add(ticket);
          return ticket.startsWith("valid-ticket-") ? account : nonMember;
        }),
    });
    const authenticate = (accountTicket: string) =>
      fetch(`${base}${TEAM_API_ROUTES.auth.account}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountTicket }),
      });

    // Each reconnect uses a different one-use signed ticket but the same client IP and account.
    // Successful refreshes must not consume the failure-only sign-in budget.
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await authenticate(`valid-ticket-${attempt}`);
      expect(response.status, await response.clone().text()).toBe(200);
      const session = await response.json();
      expect(session).toMatchObject({ member: { email: account.email }, sessionToken: expect.any(String) });
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await authenticate(`invalid-ticket-${attempt}`);
      expect(response.status).toBe(401);
    }
    const rateLimited = await authenticate("invalid-ticket-6");
    expect(rateLimited.status).toBe(429);

    // A valid signed ticket remains sufficient proof even after failed guesses from this peer.
    const recovered = await authenticate("valid-ticket-after-failures");
    expect(recovered.status, await recovered.clone().text()).toBe(200);

    // A valid account ticket for somebody who is not a Team member must keep the existing 400
    // response (not become an unexpected 500), and these authorization failures remain limited.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await authenticate(`non-member-ticket-${attempt}`);
      expect(response.status, await response.clone().text()).toBe(400);
    }
    const blockedNonMember = await authenticate("non-member-ticket-6");
    expect(blockedNonMember.status).toBe(429);
  });

  it("keeps the invited login name separate from the member's profile name", async () => {
    const { store, start } = await createTeamApiFixture("server", { configure: true });
    const { base } = await start({ agents: createAgents() });
    const invite = await Effect.runPromise(store.createInvite("member"));

    const joined = await jsonRequest<{ member: { username: string; name: string | null } }>(base, "/v1/join", {
      body: {
        inviteToken: invite.token,
        username: "device-b1b611f6f24a865d",
        password: "a secure team password",
        displayName: "Alice Example",
      },
    });

    expect(joined.member).toMatchObject({ username: "device-b1b611f6f24a865d", name: "Alice Example" });
    expect(store.listMembers()).toContainEqual(
      expect.objectContaining({ username: "device-b1b611f6f24a865d", name: "Alice Example" }),
    );
  });

  it("lets a member leave with the same effect as an admin removal, and refuses the owner", async () => {
    const { store, start } = await createTeamApiFixture("server", { configure: true });
    const { base } = await start({ agents: createAgents() });
    const ownerLogin = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
      body: { username: "owner", password: "correct horse battery" },
    });
    const invite = await Effect.runPromise(store.createInvite("member"));
    const joined = await jsonRequest<{ sessionToken: string }>(base, "/v1/join", {
      body: { inviteToken: invite.token, username: "alice", password: "a secure team password" },
    });
    // A second device, so the leave has to end every session of the member, not only the caller's.
    const otherDevice = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
      body: { username: "alice", password: "a secure team password" },
    });

    await emptyRequest(base, "/v1/team/leave", { token: joined.sessionToken });

    expect(store.listMembers().map((member) => member.username)).toEqual(["owner"]);
    expect(store.authenticate(joined.sessionToken)).toBeNull();
    expect(store.authenticate(otherDevice.sessionToken)).toBeNull();

    const ownerLeave = await fetch(`${base}/v1/team/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerLogin.sessionToken}` },
    });
    expect(ownerLeave.status).toBe(400);
    expect(store.authenticate(ownerLogin.sessionToken)).not.toBeNull();
  });

  it("manages invites, members, sessions, and password changes on loopback", async () => {
    const { store, start } = await createTeamApiFixture("server", { configure: true });
    const agents = createAgents();
    const { base } = await start({
      agents,
      createInvite: (input) =>
        Effect.gen(function* () {
          const created = yield* store.createInvite(input.role, input.email, { permanent: input.permanent });
          return {
            id: created.id,
            role: created.role,
            expiresAt: created.expiresAt,
            usedAt: null,
            inviteUrl: `https://openbot.run/join?token=${created.token}`,
            email: created.email,
            permanent: created.permanent,
            useCount: created.useCount,
          };
        }),
    });

    const ownerLogin = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
      body: { username: "owner", password: "correct horse battery" },
    });
    const ownerToken = ownerLogin.sessionToken;
    const invite = await jsonRequest<{ id: string; inviteUrl: string }>(base, "/v1/team/invites", {
      token: ownerToken,
      body: { role: "member" },
    });
    const inviteToken = new URL(invite.inviteUrl).searchParams.get("token");
    expect(inviteToken).not.toBeNull();
    const joined = await jsonRequest<{ member: { id: string }; sessionToken: string }>(base, "/v1/join", {
      body: {
        inviteToken,
        username: "alice",
        password: "a secure team password",
      },
    });
    const updated = await jsonRequest<{ role: string }>(base, `/v1/team/members/${joined.member.id}`, {
      method: "PATCH",
      token: ownerToken,
      body: { role: "admin" },
    });
    expect(updated.role).toBe("admin");

    const sessions = await jsonRequest<Array<{ id: string; username: string }>>(base, "/v1/team/sessions", {
      token: ownerToken,
    });
    const aliceSession = sessions.find((session) => session.username === "alice");
    expect(aliceSession).toBeDefined();
    await emptyRequest(base, `/v1/team/sessions/${aliceSession?.id}`, {
      method: "DELETE",
      token: ownerToken,
    });
    expect(store.authenticate(joined.sessionToken)).toBeNull();

    await emptyRequest(base, `/v1/team/invites/${invite.id}`, {
      method: "DELETE",
      token: ownerToken,
    });
    await emptyRequest(base, `/v1/team/members/${joined.member.id}`, {
      method: "DELETE",
      token: ownerToken,
    });
    expect(store.listMembers().map((member) => member.username)).toEqual(["owner"]);
    await emptyRequest(base, "/v1/auth/password", {
      token: ownerToken,
      body: {
        currentPassword: "correct horse battery",
        newPassword: "a newer secure password",
      },
    });
    expect(store.authenticate(ownerToken)).toBeNull();
  });
});
