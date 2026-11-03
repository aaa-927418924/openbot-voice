import type { AccountServerDirectoryEntry } from "@openbot/contracts/account-server-directory";
import type {
  AgentEvent,
  ChannelSummary,
  ConversationPage,
  SidebarLayoutSnapshot,
  TeamRealtimeEvent,
} from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  CLEAR_CONVERSATION_HISTORY_ROUTE,
  CONVERSATION_HISTORY_DELETE_CAPABILITY,
  DELETE_CONVERSATION_MESSAGE_ROUTE,
} from "@openbot/contracts/team-protocol/conversation-history-delete-v1";
import { HOST_ADMIN_CAPABILITY, HOST_ADMIN_ROUTES } from "@openbot/contracts/team-protocol/host-admin-v1";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { remoteHostFingerprint } from "@openbot/team-client";
import type { RemoteTeamConnectionUpdate } from "@openbot/team-client/remote-peer";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, type PropsWithChildren, useImperativeHandle, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RemoteTeamTransportRef } from "../components/remote-team-transport";
import { createTailnetMemberDeviceLinkUrl } from "../model/local-tailnet";
import { mobileSidebarItems } from "../model/sidebar-layout";
import { MobileWorkspaceProvider, useMobileWorkspace } from "./mobile-workspace-context";

const native = vi.hoisted(() => ({
  state: "active",
  listeners: new Set<(state: string) => void>(),
  storage: new Map<string, string>(),
}));
const accountDirectory = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<AccountServerDirectoryEntry[]> => []),
  getExclusions: vi.fn(async (): Promise<string[]> => []),
  register: vi.fn(async (): Promise<AccountServerDirectoryEntry[]> => []),
  remove: vi.fn(async () => {}),
}));
const localTailnetAuth = vi.hoisted(() => ({
  login: vi.fn(),
  pair: vi.fn(),
}));
const sent = vi.hoisted((): { method: string; path: string; body: unknown }[] => []);
const routedRequests = vi.hoisted((): { hostId: string | null; method: string; path: string; body: unknown }[] => []);
const host: {
  hostId: string;
  name: string;
  logoKey: string | null;
  devicePublicKey: string;
  membershipId: string;
  role: string;
} = {
  hostId: "host",
  name: "Desktop",
  logoKey: null,
  devicePublicKey: "trusted-key",
  membershipId: "membership",
  role: "owner",
};
const additionalHosts: (typeof host)[] = [];
const secondaryHost = {
  hostId: "other",
  name: "Other desktop",
  logoKey: null,
  devicePublicKey: "other-trusted-key",
  membershipId: "other-membership",
  role: "owner",
};
const session = {
  apiUrl: "https://account.example.com",
  sessionToken: "test-token",
  user: { id: "user", name: "User", email: "user@example.com", avatarUrl: null },
  host: { hostId: host.hostId, fingerprint: remoteHostFingerprint(host.devicePublicKey) },
  localOnly: false,
};
vi.mock("@/features/auth/context/mobile-session-context", () => ({
  useMobileSession: () => ({ session, sessionScope: 1 }),
}));
vi.mock("@/features/auth/api/mobile-auth", () => ({
  getLegacyAccountServerDirectoryExclusions: accountDirectory.getExclusions,
  listAccountServers: accountDirectory.list,
  registerAccountServer: accountDirectory.register,
  removeAccountServer: accountDirectory.remove,
}));
vi.mock("@/features/workspace/model/local-tailnet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/model/local-tailnet")>();
  return {
    ...actual,
    loginTailnetAccountServer: localTailnetAuth.login,
    pairTailnetInvite: localTailnetAuth.pair,
  };
});
// Native storage, lifecycle, and the DOM bridge have no runtime in this React harness.
vi.mock("react-native", () => ({
  View: ({ children }: PropsWithChildren) => <div>{children}</div>,
  Alert: { alert: () => {} },
  AppState: {
    get currentState() {
      return native.state;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
  },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock("expo/fetch", () => ({ fetch: async () => Response.json({ hosts: [host, ...additionalHosts] }) }));
vi.mock("expo-secure-store", () => ({
  getItem: (key: string) => native.storage.get(key) ?? null,
  setItem: (key: string, value: string) => native.storage.set(key, value),
  getItemAsync: async (key: string) => native.storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    native.storage.set(key, value);
  },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
}));
let sidebarSupported = false;
let hostAdminSupported = false;
let conversationHistorySupported = false;
let identityFailure: Error | null = null;
let compatibilityOrigin: "cloud" | null = null;
let initialConversationReads: Record<
  string,
  { unreadCount: number; firstUnreadMessageId: string | null; throughMessageId: string | null }
> = {};
let pendingConversationRead: Promise<unknown> | null = null;
let pendingConversationReadsRequest: Promise<unknown> | null = null;
let emptyInitialAgentList = false;
const initialLayout: SidebarLayoutSnapshot = {
  revision: 1,
  sections: [
    { id: "work", name: "Work" },
    { id: "empty", name: "Empty" },
  ],
  order: ["people", "work", "empty", "unassigned"],
  agentAssignments: { working: "work", waiting: "work" },
  agentOrder: ["waiting", "working"],
};
const sidebarRequest = vi.fn(
  async (_method: string, _body?: TeamProtocolV2Json): Promise<SidebarLayoutSnapshot> => initialLayout,
);
let emit = (_event: AgentEvent | TeamRealtimeEvent) => {};
let disconnect = () => {};
let reconnectSnapshot: AgentEvent | null = null;
vi.mock("../components/remote-team-transport", () => ({
  RemoteTeamTransport: ({
    ref,
    onTeamEvent,
    onConnectionUpdate,
  }: {
    ref: React.Ref<RemoteTeamTransportRef>;
    onTeamEvent(hostId: string, event: AgentEvent | TeamRealtimeEvent): void;
    onConnectionUpdate(update: RemoteTeamConnectionUpdate): void;
  }) => {
    const callbacks = useRef({ onTeamEvent, onConnectionUpdate });
    const connectedHostId = useRef<string | null>(null);
    callbacks.current = { onTeamEvent, onConnectionUpdate };
    useImperativeHandle(
      ref,
      () => ({
        connect: async (hostId: string) => {
          connectedHostId.current = hostId;
          emit = (event) => callbacks.current.onTeamEvent(hostId, event);
          disconnect = () => callbacks.current.onConnectionUpdate({ hostId, state: "offline", message: null });
          if (reconnectSnapshot) emit(reconnectSnapshot);
        },
        disconnect: async () => {},
        request: async <T,>(
          method: string,
          path: string,
          decode: (value: unknown) => T,
          body?: TeamProtocolV2Json,
        ): Promise<T> => {
          sent.push({ method, path, body });
          routedRequests.push({ hostId: connectedHostId.current, method, path, body });
          if (path === TEAM_API_ROUTES.agent.interrupt("working")) return decode({});
          if (path === TEAM_API_ROUTES.sidebarLayout.state || path === TEAM_API_ROUTES.sidebarLayout.actions)
            return decode(await sidebarRequest(method, body));
          if (path === TEAM_API_ROUTES.compatibility)
            return decode({
              appVersion: "test",
              ...(compatibilityOrigin ? { origin: compatibilityOrigin } : {}),
              protocol: { minimum: 3, maximum: 3 },
              capabilities: [
                ...(sidebarSupported ? ["sidebar-layout"] : []),
                ...(hostAdminSupported ? [HOST_ADMIN_CAPABILITY] : []),
                ...(conversationHistorySupported ? [CONVERSATION_HISTORY_DELETE_CAPABILITY] : []),
              ],
            });
          if (path === TEAM_API_ROUTES.agents.all)
            return decode(
              emptyInitialAgentList
                ? []
                : ["working", "waiting"].map((id) => ({
                    id,
                    name: id,
                    title: "",
                    description: "",
                    preview: "",
                    updatedAt: null,
                    avatarSeed: "first-bot",
                    avatarHue: null,
                  })),
            );
          if (path === DELETE_CONVERSATION_MESSAGE_ROUTE || path === CLEAR_CONVERSATION_HISTORY_ROUTE)
            return decode({});
          if (path === `${TEAM_API_ROUTES.agent.conversationPage("working")}?limit=50`)
            return decode({
              agentId: "working",
              threadId: null,
              activeTurnId: null,
              revision: 1,
              messages: [],
              references: {},
              pageInfo: { hasOlder: false, olderCursor: null },
            } satisfies ConversationPage);
          if (path === TEAM_API_ROUTES.agents.conversationReads)
            return decode(
              pendingConversationReadsRequest ? await pendingConversationReadsRequest : initialConversationReads,
            );
          if (path === TEAM_API_ROUTES.agent.conversationRead("working") && pendingConversationRead)
            return decode(await pendingConversationRead);
          if (path === HOST_ADMIN_ROUTES.identity) {
            if (identityFailure) throw identityFailure;
            return decode({});
          }
          throw new Error(`Unexpected request: ${path}`);
        },
      }),
      [],
    );
    return null;
  },
}));

let current: ReturnType<typeof useMobileWorkspace>;
function Workspace() {
  current = useMobileWorkspace();
  return null;
}
const container = document.createElement("div");
let root = createRoot(container);
const queryClient = new QueryClient();
afterEach(async () => {
  await act(() => root.unmount());
  root = createRoot(container);
  queryClient.clear();
  native.state = "active";
  native.storage.clear();
  sent.length = 0;
  routedRequests.length = 0;
  additionalHosts.length = 0;
  reconnectSnapshot = null;
  sidebarSupported = false;
  hostAdminSupported = false;
  conversationHistorySupported = false;
  identityFailure = null;
  compatibilityOrigin = null;
  initialConversationReads = {};
  pendingConversationRead = null;
  pendingConversationReadsRequest = null;
  emptyInitialAgentList = false;
  Object.assign(host, { name: "Desktop", logoKey: null, role: "owner" });
  session.apiUrl = "https://account.example.com";
  session.sessionToken = "test-token";
  session.host.hostId = host.hostId;
  session.localOnly = false;
  sidebarRequest.mockReset();
  sidebarRequest.mockResolvedValue(initialLayout);
  accountDirectory.list.mockReset();
  accountDirectory.list.mockResolvedValue([]);
  accountDirectory.getExclusions.mockReset();
  accountDirectory.getExclusions.mockResolvedValue([]);
  accountDirectory.register.mockReset();
  accountDirectory.register.mockResolvedValue([]);
  accountDirectory.remove.mockReset();
  accountDirectory.remove.mockResolvedValue();
  localTailnetAuth.login.mockReset();
  localTailnetAuth.pair.mockReset();
});

it.each(["foreground", "manual"])(
  "preserves waiting and working activity during a healthy %s refresh",
  async (reason) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <MobileWorkspaceProvider>
            <Workspace />
          </MobileWorkspaceProvider>
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      emit({ type: "turn-started", agentId: "working", threadId: "thread", turnId: "running-turn" });
      emit({
        type: "approval",
        approval: {
          agentId: "waiting",
          threadId: "thread",
          turnId: "waiting-turn",
          requestId: "request",
          kind: "command",
          command: "pwd",
          cwd: null,
          reason: null,
          grantRoot: null,
          permissions: null,
        },
      });
    });
    if (reason === "foreground") {
      await act(async () => {
        native.state = "background";
        for (const listener of native.listeners) listener("background");
      });
      await act(async () => {
        native.state = "active";
        for (const listener of native.listeners) listener("active");
      });
    } else await act(async () => current.refreshServer(host.hostId));
    expect(current.liveState.get().activityByServer[host.hostId]).toEqual({
      working: { turnId: "running-turn", phase: "working", detail: null },
      waiting: { turnId: "waiting-turn", phase: "waiting", detail: null },
    });

    // A real replacement receives an authoritative snapshot, which clears finished work.
    reconnectSnapshot = {
      type: "runtime-snapshot",
      snapshot: {
        agents: [],
        activeTurns: [],
        work: [],
        latestMessages: [],
        attentionComplete: true,
        pendingPrompts: [],
        pendingApprovals: [],
        pendingBrowserTakeovers: [],
        failedTurns: [],
      },
    };
    await act(async () => disconnect());
    expect(current.liveState.get().activityByServer[host.hostId]).toEqual({});
  },
);

it.each(["memories", "routines"] as const)("refreshes active channel %s after a remote edit", async (section) => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MobileWorkspaceProvider>
          <Workspace />
        </MobileWorkspaceProvider>
      </QueryClientProvider>,
    ),
  );
  let records = ["original"];
  const key = ["channel-info", session.apiUrl, session.user.id, 1, host.hostId, "channel", section];
  const read = vi.fn(async () => records);
  const observer = new QueryObserver(queryClient, { queryKey: key, queryFn: read, staleTime: Infinity });
  const close = observer.subscribe(() => {});
  await observer.refetch();
  const reads = read.mock.calls.length;
  await act(async () => emit({ type: "channels-changed", channelId: "channel", revision: 1 }));
  expect(read).toHaveBeenCalledTimes(reads);
  const otherKey = [...key.slice(0, 5), "other-channel", section];
  queryClient.setQueryData(otherKey, ["unchanged"]);
  records = [];
  await act(async () =>
    emit({
      type: section === "memories" ? "channel-memories-changed" : "channel-routines-changed",
      channelId: "channel",
    }),
  );
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([]));
  expect(queryClient.getQueryData(otherKey)).toEqual(["unchanged"]);
  expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  close();
});

async function mountSidebar() {
  sidebarSupported = true;
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MobileWorkspaceProvider>
          <Workspace />
        </MobileWorkspaceProvider>
      </QueryClientProvider>,
    ),
  );
}
function sidebarRows() {
  return mobileSidebarItems(current.sidebarByServer.host?.layout ?? null, current.activeAgents, []).map(
    (item) => item.id,
  );
}

it("loads host sections and agent order, applies desktop events, and reloads after remount", async () => {
  await mountSidebar();
  expect(sidebarRows()).toEqual(["work", "waiting", "working", "empty"]);
  const changed: SidebarLayoutSnapshot = {
    ...initialLayout,
    revision: 2,
    order: ["empty", "unassigned", "work", "people"],
    agentAssignments: { working: "work" },
  };
  await act(async () => emit({ type: "sidebar-layout-changed", layout: changed }));
  expect(sidebarRows()).toEqual(["empty", "unassigned", "waiting", "work", "working"]);
  await act(async () => emit({ type: "sidebar-layout-changed", layout: initialLayout }));
  expect(current.sidebarByServer.host?.layout).toEqual(changed);
  sidebarRequest.mockResolvedValue(changed);
  await act(async () => current.refreshServer("host"));
  expect(sidebarRows()).toEqual(["empty", "unassigned", "waiting", "work", "working"]);
  await act(async () => root.unmount());
  root = createRoot(container);
  await mountSidebar();
  expect(current.sidebarByServer.host?.layout).toEqual(changed);
});

it("sends section actions to the chosen host and keeps a newer event over an action response", async () => {
  await mountSidebar();
  const changed = {
    ...initialLayout,
    revision: 3,
    sections: [
      { id: "work", name: "Renamed" },
      { id: "empty", name: "Empty" },
    ],
  };
  sidebarRequest.mockImplementationOnce(async () => {
    emit({ type: "sidebar-layout-changed", layout: changed });
    return { ...initialLayout, revision: 2 };
  });
  await act(async () => current.mutateSidebarLayout("host", { type: "rename", sectionId: "work", name: "Renamed" }));
  expect(sidebarRequest).toHaveBeenLastCalledWith("POST", { type: "rename", sectionId: "work", name: "Renamed" });
  expect(current.sidebarByServer.host?.layout).toEqual(changed);
  await expect(current.mutateSidebarLayout("other-host", { type: "delete", sectionId: "work" })).rejects.toThrow(
    "does not support",
  );
  sidebarRequest.mockRejectedValueOnce(new Error("Save failed"));
  await act(async () => {
    await expect(current.mutateSidebarLayout("host", { type: "delete", sectionId: "work" })).rejects.toThrow(
      "Save failed",
    );
  });
  expect(current.sidebarByServer.host?.layout).toEqual(changed);
});

it("keeps chats visible on layout failure and recovers on retry", async () => {
  sidebarRequest.mockRejectedValueOnce(new Error("Layout unavailable"));
  await mountSidebar();
  expect(current.sidebarByServer.host?.error).toBeTruthy();
  expect(sidebarRows()).toEqual(["working", "waiting"]);
  await act(async () => current.refreshServer("host"));
  expect(current.sidebarByServer.host?.error).toBeNull();
  expect(sidebarRows()).toEqual(["work", "waiting", "working", "empty"]);
});

it("returns chats to Agents on section deletion and supports unassignment", async () => {
  await mountSidebar();
  const unassigned = { ...initialLayout, revision: 2, agentAssignments: { waiting: "work" } };
  sidebarRequest.mockResolvedValueOnce(unassigned);
  await act(async () => current.mutateSidebarLayout("host", { type: "assign", agentId: "working", sectionId: null }));
  expect(sidebarRows()).toEqual(["work", "waiting", "empty", "unassigned", "working"]);
  const deleted = { ...unassigned, revision: 3, sections: [], order: ["people", "unassigned"], agentAssignments: {} };
  await act(async () => emit({ type: "sidebar-layout-changed", layout: deleted }));
  expect(sidebarRows()).toEqual(["unassigned", "waiting", "working"]);
});

it("mixes channels and agents in the host order and retains new and orphaned chats", async () => {
  await mountSidebar();
  const channel: ChannelSummary = {
    id: "channel",
    name: "Planning",
    title: "",
    instructions: "",
    members: [],
    leadAgentId: null,
    archived: false,
    revision: 1,
    createdAt: "2026-09-21T00:00:00Z",
    unreadCount: 0,
    activeTasks: 0,
    lastMessage: null,
  };
  const layout = {
    ...initialLayout,
    agentOrder: ["waiting", "channel"],
    agentAssignments: { waiting: "work", channel: "work", working: "deleted" },
  };
  expect(mobileSidebarItems(layout, current.activeAgents, [channel]).map((item) => item.id)).toEqual([
    "work",
    "waiting",
    "channel",
    "empty",
    "unassigned",
    "working",
  ]);
  const many = Array.from({ length: 2000 }, (_, index) => ({ ...channel, id: `channel-${index}` }));
  const largeLayout = { ...initialLayout, agentAssignments: {}, agentOrder: many.map((item) => item.id).reverse() };
  expect(
    mobileSidebarItems(largeLayout, [], many)
      .filter((item) => item.kind === "channel")
      .map((item) => item.id),
  ).toEqual(largeLayout.agentOrder);
});

it("keeps a desktop event that arrives during a layout read", async () => {
  const newer = { ...initialLayout, revision: 4, agentOrder: ["working", "waiting"] };
  sidebarRequest.mockImplementationOnce(async () => {
    emit({ type: "sidebar-layout-changed", layout: newer });
    return initialLayout;
  });
  await mountSidebar();
  expect(sidebarRows()).toEqual(["work", "working", "waiting", "empty"]);
});

it("sends section reorder actions and uses the returned order", async () => {
  await mountSidebar();
  const reordered = { ...initialLayout, revision: 2, order: ["people", "empty", "work", "unassigned"] };
  sidebarRequest.mockResolvedValueOnce(reordered);
  await act(async () =>
    current.mutateSidebarLayout("host", { type: "move", sectionId: "empty", direction: "up", steps: 1 }),
  );
  expect(sidebarRequest).toHaveBeenLastCalledWith("POST", {
    type: "move",
    sectionId: "empty",
    direction: "up",
    steps: 1,
  });
  expect(sidebarRows()).toEqual(["empty", "work", "waiting", "working"]);
});

it("stops a running turn through the interrupt route", async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MobileWorkspaceProvider>
          <Workspace />
        </MobileWorkspaceProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => current.interruptTurn("working", "running-turn", host.hostId));
  expect(sent.at(-1)).toEqual({
    method: "POST",
    path: TEAM_API_ROUTES.agent.interrupt("working"),
    body: { turnId: "running-turn" },
  });
});

async function mountWorkspace() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MobileWorkspaceProvider>
          <Workspace />
        </MobileWorkspaceProvider>
      </QueryClientProvider>,
    ),
  );
}

it("loads a local-only workspace without constructing an account directory client", async () => {
  session.apiUrl = "http://127.0.0.1/";
  session.sessionToken = "";
  session.localOnly = true;

  await mountWorkspace();

  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));
  expect(current.servers).toEqual([]);
  expect(current.serverDirectoryError).toBeNull();
});

it("keeps direct unclaimed Tailnet pairings in the unauthenticated local profile", async () => {
  session.apiUrl = "http://127.0.0.1/";
  session.sessionToken = "";
  session.localOnly = true;
  const { localHost } = addLegacyLocalTailnetServer(null);
  native.storage.set(
    "openbot.mobile.local-tailnet.v1",
    JSON.stringify([{ ...localHost, hostId: "previous-account-host", accountId: "previous-account" }, localHost]),
  );

  await mountWorkspace();

  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));
  expect(current.servers.map((server) => server.id)).toEqual([localHost.hostId]);
  expect(current.servers[0]).toHaveProperty("tailnet");
  expect(accountDirectory.list).not.toHaveBeenCalled();
});

it("does not expose another account's cached pairing immediately after an unauthenticated pairing", async () => {
  session.apiUrl = "http://127.0.0.1/";
  session.sessionToken = "";
  session.localOnly = true;
  const { localHost: foreignHost } = addLegacyLocalTailnetServer("account-b");
  const { accountId: _accountId, ...unclaimedBase } = foreignHost;
  const unclaimedHost = {
    ...unclaimedBase,
    hostId: "00000000-0000-4000-8000-000000000002",
    membershipId: "new-membership",
    role: "member" as const,
  };
  const inviteUrl = createTailnetMemberDeviceLinkUrl(unclaimedHost, "e".repeat(43));
  localTailnetAuth.pair.mockResolvedValue(unclaimedHost);

  await mountWorkspace();
  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));

  await act(async () => current.addRemoteServer({ inviteUrl }));

  expect(current.servers.map((server) => server.id)).toEqual([unclaimedHost.hostId]);
  expect(current.servers[0]).toMatchObject({ tailnet: { membershipId: unclaimedHost.membershipId } });
});

it("reuses an unclaimed local token for a member device link while signed out", async () => {
  session.apiUrl = "http://127.0.0.1/";
  session.sessionToken = "";
  session.localOnly = true;
  const { localHost: legacyHost } = addLegacyLocalTailnetServer();
  const localHost = {
    ...legacyHost,
    hostId: "00000000-0000-4000-8000-000000000003",
    role: "owner" as const,
  };
  native.storage.set("openbot.mobile.local-tailnet.v1", JSON.stringify([localHost]));
  const inviteUrl = createTailnetMemberDeviceLinkUrl(localHost, "f".repeat(43));
  localTailnetAuth.pair.mockResolvedValue(localHost);

  await mountWorkspace();
  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));

  await act(async () => current.addRemoteServer({ inviteUrl }));

  expect(localTailnetAuth.pair).toHaveBeenCalledWith(
    inviteUrl,
    expect.objectContaining({ existingSessionToken: localHost.sessionToken }),
  );
  expect(localTailnetAuth.pair.mock.calls[0]?.[1]).not.toHaveProperty("accountId");
});

it("selects an account-listed server when this device has no local pairing", async () => {
  session.localOnly = true;
  const remoteEntry: AccountServerDirectoryEntry = {
    hostId: "remote-host",
    name: "Remote host",
    logoKey: null,
    apiUrl: "http://100.100.10.3:43123/",
    publicKey: "remote-key",
    fingerprint: remoteHostFingerprint("remote-key"),
    membershipId: "remote-membership",
    role: "member",
    isOwner: false,
  };
  accountDirectory.list.mockResolvedValue([remoteEntry]);

  await mountWorkspace();

  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));
  expect(current.servers.map((server) => server.id)).toEqual([remoteEntry.hostId]);
  expect(current.activeServer.id).toBe(remoteEntry.hostId);
});

it("marks a legacy account-directory server as Cloud when the connected host reports its origin", async () => {
  session.localOnly = true;
  compatibilityOrigin = "cloud";
  const remoteEntry: AccountServerDirectoryEntry = {
    hostId: "cloud-host",
    name: "OpenBot Cloud",
    logoKey: null,
    apiUrl: "http://100.100.10.4:43123/",
    publicKey: "cloud-key",
    fingerprint: remoteHostFingerprint("cloud-key"),
    membershipId: "cloud-membership",
    role: "member",
    isOwner: false,
  };
  accountDirectory.list.mockResolvedValue([remoteEntry]);

  await mountWorkspace();

  await vi.waitFor(() =>
    expect(current.servers[0]).toMatchObject({
      id: remoteEntry.hostId,
      origin: "cloud",
      accountServer: { origin: "cloud" },
    }),
  );
  expect(accountDirectory.register).toHaveBeenCalledWith(
    session,
    expect.objectContaining({ hostId: remoteEntry.hostId, origin: "cloud" }),
  );
});

function addLegacyLocalTailnetServer(accountId: string | null = null) {
  const fingerprint = remoteHostFingerprint(host.devicePublicKey);
  const localHost = {
    hostId: host.hostId,
    name: host.name,
    logoKey: host.logoKey,
    apiUrl: "http://100.100.10.2:43123",
    publicKey: host.devicePublicKey,
    fingerprint,
    sessionToken: "team-device-token",
    membershipId: host.membershipId,
    role: "owner",
    ...(accountId ? { accountId } : {}),
  };
  const directoryEntry: AccountServerDirectoryEntry = {
    hostId: localHost.hostId,
    name: localHost.name,
    logoKey: localHost.logoKey,
    apiUrl: localHost.apiUrl,
    publicKey: localHost.publicKey,
    fingerprint: localHost.fingerprint,
    membershipId: localHost.membershipId,
    role: "owner",
    isOwner: true,
  };
  native.storage.set("openbot.mobile.local-tailnet.v1", JSON.stringify([localHost]));
  return { localHost, directoryEntry };
}

it("imports an old local pairing for this device with the legacyImport marker", async () => {
  session.localOnly = true;
  const { localHost, directoryEntry } = addLegacyLocalTailnetServer();
  const accountHost = { ...localHost, accountId: session.user.id, sessionToken: "account-ticket-token" };
  localTailnetAuth.login.mockResolvedValue(accountHost);
  accountDirectory.list.mockResolvedValue([]);
  accountDirectory.register.mockResolvedValue([directoryEntry]);

  await mountWorkspace();

  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));
  expect(localTailnetAuth.login).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: localHost.hostId, membershipId: localHost.membershipId }),
    expect.objectContaining({
      accountId: session.user.id,
      identitySession: { apiUrl: session.apiUrl, sessionToken: session.sessionToken },
    }),
  );
  expect(accountDirectory.register).toHaveBeenCalledWith(
    session,
    expect.objectContaining({
      hostId: localHost.hostId,
      apiUrl: localHost.apiUrl,
      publicKey: localHost.publicKey,
    }),
    { legacyImport: true },
  );
  expect(current.servers.map((server) => server.id)).toEqual([host.hostId]);
  expect(JSON.parse(native.storage.get("openbot.mobile.local-tailnet.v1") ?? "[]")).toContainEqual({
    ...accountHost,
    apiUrl: `${localHost.apiUrl}/`,
  });
});

it("does not import a legacy pairing excluded by the account server", async () => {
  session.localOnly = true;
  addLegacyLocalTailnetServer();
  accountDirectory.list.mockResolvedValue([]);
  accountDirectory.getExclusions.mockResolvedValue([host.hostId]);

  await mountWorkspace();

  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));
  expect(accountDirectory.register).not.toHaveBeenCalled();
  expect(current.servers).toEqual([]);
});

it("keeps an authoritative empty server list when optional cache-exclusion lookup fails", async () => {
  session.localOnly = true;
  const { localHost, directoryEntry } = addLegacyLocalTailnetServer(session.user.id);
  accountDirectory.list.mockResolvedValueOnce([directoryEntry]).mockResolvedValue([]);
  accountDirectory.getExclusions.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Directory unavailable."));

  await mountWorkspace();
  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));
  expect(current.servers.map((server) => server.id)).toContain(localHost.hostId);

  await act(async () => current.refreshServers());

  expect(accountDirectory.list).toHaveBeenCalledTimes(2);
  expect(accountDirectory.getExclusions).toHaveBeenCalledTimes(2);
  expect(current.servers).toEqual([]);
  expect(native.storage.get("openbot.mobile.local-tailnet.v1")).toContain(localHost.hostId);
});

it("keeps an unclaimed device pairing out of another account's directory", async () => {
  session.localOnly = true;
  const { localHost } = addLegacyLocalTailnetServer(null);
  accountDirectory.list.mockResolvedValue([]);

  await mountWorkspace();

  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));
  expect(accountDirectory.register).not.toHaveBeenCalled();
  expect(current.servers).toEqual([]);
  expect(JSON.parse(native.storage.get("openbot.mobile.local-tailnet.v1") ?? "[]")).toContainEqual(localHost);
});

it("does not reuse another account's cached token when redeeming a member device link", async () => {
  session.localOnly = true;
  const { localHost } = addLegacyLocalTailnetServer("previous-account");
  const linkHost = { ...localHost, hostId: "00000000-0000-4000-8000-000000000001", role: "owner" as const };
  native.storage.set("openbot.mobile.local-tailnet.v1", JSON.stringify([linkHost]));
  const inviteUrl = createTailnetMemberDeviceLinkUrl(linkHost, "d".repeat(43));
  localTailnetAuth.pair.mockResolvedValue({ ...linkHost, accountId: session.user.id });

  await mountWorkspace();
  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));

  await act(async () => current.addRemoteServer({ inviteUrl }));

  expect(localTailnetAuth.pair).toHaveBeenCalledWith(
    inviteUrl,
    expect.objectContaining({ existingSessionToken: undefined, accountId: session.user.id }),
  );
});

it("does not re-register a legacy pairing that is already in the account directory", async () => {
  session.localOnly = true;
  const { directoryEntry } = addLegacyLocalTailnetServer();
  accountDirectory.list.mockResolvedValue([directoryEntry]);

  await mountWorkspace();

  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));
  expect(accountDirectory.register).not.toHaveBeenCalled();
  expect(current.servers.map((server) => server.id)).toEqual([host.hostId]);
});

it("does not reuse a device token from a different account membership on the same host", async () => {
  session.localOnly = true;
  const { localHost, directoryEntry } = addLegacyLocalTailnetServer("user");
  localHost.membershipId = "previous-account-membership";
  localHost.role = "owner";
  native.storage.set("openbot.mobile.local-tailnet.v1", JSON.stringify([localHost]));
  accountDirectory.list.mockResolvedValue([
    { ...directoryEntry, membershipId: "current-account-membership", role: "member", isOwner: false },
  ]);

  await mountWorkspace();

  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));
  expect(current.servers).toMatchObject([
    { id: host.hostId, membershipId: "current-account-membership", role: "member" },
  ]);
  expect(current.servers[0]).not.toHaveProperty("tailnet");
});

it("does not reuse a device token confirmed for another account even when the membership id matches", async () => {
  session.localOnly = true;
  const { localHost, directoryEntry } = addLegacyLocalTailnetServer("previous-account");
  accountDirectory.list.mockResolvedValue([directoryEntry]);

  await mountWorkspace();

  await vi.waitFor(() => expect(current.serverDirectoryState).toBe("ready"));
  expect(current.servers).toMatchObject([{ id: host.hostId, membershipId: host.membershipId }]);
  expect(current.servers[0]).not.toHaveProperty("tailnet");
  expect(JSON.parse(native.storage.get("openbot.mobile.local-tailnet.v1") ?? "[]")).toContainEqual(localHost);
});

it("keeps the local pairing when removing the account directory membership fails", async () => {
  session.localOnly = true;
  host.role = "member";
  const { localHost, directoryEntry } = addLegacyLocalTailnetServer("user");
  localHost.role = "member";
  native.storage.set("openbot.mobile.local-tailnet.v1", JSON.stringify([localHost]));
  const memberEntry = { ...directoryEntry, role: "member" as const, isOwner: false };
  accountDirectory.list.mockResolvedValue([memberEntry]);
  accountDirectory.remove.mockRejectedValueOnce(new Error("Account server unavailable."));

  await mountWorkspace();
  await vi.waitFor(() => expect(current.servers.map((server) => server.id)).toContain(host.hostId));

  await expect(current.leaveServer(host.hostId)).rejects.toThrow("Account server unavailable.");
  expect(current.servers.map((server) => server.id)).toContain(host.hostId);
  expect(JSON.parse(native.storage.get("openbot.mobile.local-tailnet.v1") ?? "[]")).toHaveLength(1);
});

it("does not restore a server after confirmed leave when the directory refresh fails", async () => {
  session.localOnly = true;
  session.host.hostId = "own-host";
  host.role = "member";
  const { localHost, directoryEntry } = addLegacyLocalTailnetServer("user");
  localHost.role = "member";
  native.storage.set("openbot.mobile.local-tailnet.v1", JSON.stringify([localHost]));
  const memberEntry = { ...directoryEntry, role: "member" as const, isOwner: false };
  accountDirectory.list.mockResolvedValue([memberEntry]);

  await mountWorkspace();
  await vi.waitFor(() => expect(current.servers.map((server) => server.id)).toContain(host.hostId));
  expect(current.servers.find((server) => server.id === host.hostId)?.role).toBe("member");
  accountDirectory.list.mockRejectedValueOnce(new Error("Account server unavailable."));

  await act(async () => current.leaveServer(host.hostId));
  await vi.waitFor(() => expect(accountDirectory.list).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(current.servers.map((server) => server.id)).not.toContain(host.hostId));
  expect(current.servers).toEqual([]);
});

it("capability-gates direct history operations on older hosts", async () => {
  await mountWorkspace();
  expect(current.canChangeConversationHistory(host.hostId)).toBe(false);
  await expect(current.deleteConversationMessage("working", "message-one", host.hostId)).rejects.toThrow(
    "Conversation history changes are not supported by this connection.",
  );
  expect(sent.some((item) => item.path === DELETE_CONVERSATION_MESSAGE_ROUTE)).toBe(false);
});

it("keeps a message unread until the host acknowledges the read", async () => {
  initialConversationReads = {
    working: { unreadCount: 1, firstUnreadMessageId: "message-one", throughMessageId: null },
  };
  const read = Promise.withResolvers<{
    unreadCount: number;
    firstUnreadMessageId: string | null;
    throughMessageId: string | null;
  }>();
  pendingConversationRead = read.promise;
  await mountWorkspace();
  await vi.waitFor(() => expect(current.liveState.get().unreadAgentIds).toContain("working"));

  await act(async () => current.markAgentRead("working", "message-one"));
  expect(current.liveState.get().unreadAgentIds).toContain("working");

  await act(async () => read.resolve({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "message-one" }));
  await vi.waitFor(() => expect(current.liveState.get().unreadAgentIds).not.toContain("working"));
});

it("sends a read acknowledgement to the agent's host rather than the selected host", async () => {
  additionalHosts.push(secondaryHost);
  pendingConversationRead = Promise.resolve({
    unreadCount: 0,
    firstUnreadMessageId: null,
    throughMessageId: "message-one",
  });
  await mountWorkspace();
  await vi.waitFor(() => expect(routedRequests.some((request) => request.hostId === "other")).toBe(true));

  await act(async () => current.markAgentRead("working", "message-one", "other"));

  await vi.waitFor(() =>
    expect(routedRequests).toContainEqual({
      hostId: "other",
      method: "POST",
      path: TEAM_API_ROUTES.agent.conversationRead("working"),
      body: { throughMessageId: "message-one" },
    }),
  );
  expect(
    routedRequests.some(
      (request) =>
        request.hostId === "host" &&
        request.method === "POST" &&
        request.path === TEAM_API_ROUTES.agent.conversationRead("working"),
    ),
  ).toBe(false);
});

it("shows agents before optional startup reads and layout finish", async () => {
  sidebarSupported = true;
  const layout = Promise.withResolvers<SidebarLayoutSnapshot>();
  const reads = Promise.withResolvers<unknown>();
  sidebarRequest.mockImplementationOnce(() => layout.promise);
  pendingConversationReadsRequest = reads.promise;

  await mountWorkspace();
  await vi.waitFor(() => expect(current.activeServer.initialAgentListLoaded).toBe(true));
  expect(current.activeAgents.map((agent) => agent.id)).toEqual(["working", "waiting"]);
  expect(sent.some((item) => item.path === TEAM_API_ROUTES.sidebarLayout.state)).toBe(true);
  expect(sent.some((item) => item.path === TEAM_API_ROUTES.agents.conversationReads)).toBe(true);

  await act(async () => {
    layout.resolve(initialLayout);
    reads.resolve({});
  });
});

it("treats an empty agent summary response as loaded", async () => {
  emptyInitialAgentList = true;
  await mountWorkspace();
  await vi.waitFor(() => expect(current.activeServer.initialAgentListLoaded).toBe(true));
  expect(current.activeAgents).toEqual([]);
});

it("uses existing direct history routes and refreshes the conversation and sidebar preview", async () => {
  conversationHistorySupported = true;
  await mountWorkspace();
  expect(current.canChangeConversationHistory(host.hostId)).toBe(true);
  expect(current.canClearConversationHistory("working", host.hostId)).toBe(true);
  await act(async () => current.deleteConversationMessage("working", "message-one", host.hostId));
  expect(sent).toContainEqual({
    method: "POST",
    path: DELETE_CONVERSATION_MESSAGE_ROUTE,
    body: { agentId: "working", messageId: "message-one" },
  });
  expect(sent.some((item) => item.path === `${TEAM_API_ROUTES.agent.conversationPage("working")}?limit=50`)).toBe(true);
  expect(sent.filter((item) => item.path === TEAM_API_ROUTES.agents.all).length).toBeGreaterThan(1);
  await act(async () => current.clearConversationHistory("working", host.hostId));
  expect(sent).toContainEqual({
    method: "POST",
    path: CLEAR_CONVERSATION_HISTORY_ROUTE,
    body: { agentId: "working" },
  });
  expect(current.agents.find((agent) => agent.id === "working")?.preview).toBe("");
});

it("saves and removes the server logo and name through the host, then reads the new logo key", async () => {
  hostAdminSupported = true;
  await mountWorkspace();
  // The directory as it is after the host saved the change.
  Object.assign(host, { name: "Research lab", logoKey: "logo-2" });
  await act(() =>
    current.updateServerIdentity(host.hostId, {
      serverName: "Research lab",
      logo: { mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) },
    }),
  );
  expect(sent.at(-1)).toEqual({
    method: "POST",
    path: HOST_ADMIN_ROUTES.identity,
    body: { serverName: "Research lab", logo: { mimeType: "image/jpeg", data: "AQID" } },
  });
  expect(current.servers[0]).toMatchObject({ name: "Research lab", logoKey: "logo-2" });

  host.logoKey = null;
  await act(() => current.updateServerIdentity(host.hostId, { logo: null }));
  expect(sent.at(-1)?.body).toEqual({ logo: null });
  expect(current.servers[0]?.logoKey).toBeNull();
});

it("keeps the saved name when the host refuses the change", async () => {
  hostAdminSupported = true;
  identityFailure = new Error("Upload failed.");
  await mountWorkspace();
  await expect(act(() => current.updateServerIdentity(host.hostId, { serverName: "Other name" }))).rejects.toThrow(
    "Upload failed.",
  );
  expect(current.servers[0]?.name).toBe("Desktop");
});

it("does not send an identity change for a member", async () => {
  hostAdminSupported = true;
  host.role = "member";
  await mountWorkspace();
  const before = sent.length;
  await expect(current.updateServerIdentity(host.hostId, { serverName: "Other name" })).rejects.toThrow();
  expect(current.canEditServerIdentity(host.hostId)).toBe(false);
  expect(sent).toHaveLength(before);
});

it("applies a name and logo change that another client made", async () => {
  await mountWorkspace();
  await act(async () =>
    emit({ type: "team-identity", serverId: host.hostId, serverName: "Renamed", logoVersion: "logo-3" }),
  );
  expect(current.servers[0]).toMatchObject({ name: "Renamed", logoKey: "logo-3" });
});
