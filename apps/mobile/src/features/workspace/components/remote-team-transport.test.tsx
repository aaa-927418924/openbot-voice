import type { AccountServerDirectoryEntry } from "@openbot/contracts/account-server-directory";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { type LocalTailnetServer, loginTailnetAccountServer } from "@/features/workspace/model/local-tailnet";
import { saveLocalTailnetServer } from "@/features/workspace/model/local-tailnet-store";
import { RemoteTeamTransport, type RemoteTeamTransportRef } from "./remote-team-transport";

const harness: {
  instances: Array<{
    server: unknown;
    connect: ReturnType<typeof vi.fn>;
    openEvents: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>;
  connectBarrier: Promise<void> | null;
  session: {
    apiUrl: string;
    sessionToken: string;
    user: { id: string };
    localOnly: boolean;
  } | null;
} = vi.hoisted(() => ({ instances: [], connectBarrier: null, session: null }));

vi.mock("@/features/auth/context/mobile-session-context", () => ({
  useMobileSession: () => ({ session: harness.session, refreshProfile: vi.fn() }),
}));
vi.mock("@/features/support/model/support-log", () => ({
  supportLog: { add: vi.fn() },
  supportLogUrl: (path: string) => path,
}));
vi.mock("@/shared/lib/expo-go-dom", () => ({ expoGoDomOptions: {} }));
vi.mock("@/shared/lib/text", () => ({ currentText: () => ({ t: (key: string) => key }) }));
vi.mock("@openbot/i18n/source", () => ({ sourceText: (key: string) => key }));
vi.mock("@openbot/team-client", () => ({ runTeamEffect: vi.fn() }));
vi.mock("@openbot/team-client/remote-peer", () => ({
  createRemoteCommandMailbox: () => ({
    send: async () => ({ ok: true, body: {} }),
    receive: vi.fn(),
    dispose: vi.fn(),
  }),
  remoteTeamRequestTimeoutMs: () => undefined,
}));
vi.mock("expo-application", () => ({ nativeApplicationVersion: "0.30.0" }));
vi.mock("expo-crypto", () => ({
  randomUUID: () => "request-id",
  getRandomBytes: (size: number) => new Uint8Array(size),
}));
vi.mock("@/features/workspace/model/local-tailnet", () => ({
  DirectTailnetTeamClient: class {
    server: unknown;
    disconnect = vi.fn();
    connect = vi.fn(async () => {
      if (harness.connectBarrier) await harness.connectBarrier;
    });
    openEvents = vi.fn(async () => {});
    request = vi.fn();

    constructor(server: unknown) {
      this.server = server;
      harness.instances.push(this);
    }
  },
  loginTailnetAccountServer: vi.fn(),
}));
vi.mock("@/features/workspace/model/local-tailnet-store", () => ({
  saveLocalTailnetServer: vi.fn(),
}));
vi.mock("./remote-team-bridge.dom", () => ({ default: () => null }));

const localPairing = (membershipId: string, accountId = "account-a") => ({
  hostId: "host",
  name: "Host",
  logoKey: null,
  apiUrl: "http://100.100.10.2:43123/",
  publicKey: "host-key",
  fingerprint: "a".repeat(43),
  sessionToken: "device-token",
  membershipId,
  role: "member" as const,
  accountId,
});

const accountServer: AccountServerDirectoryEntry = {
  hostId: "host",
  name: "Host",
  apiUrl: "http://100.100.10.2:43123/",
  publicKey: "host-key",
  fingerprint: "a".repeat(43),
  logoKey: null,
  membershipId: "membership-a",
  role: "member",
  isOwner: false,
};

const container = document.createElement("div");
document.body.append(container);
let root = createRoot(container);
const transportRef = createRef<RemoteTeamTransportRef>();
const onConnectionUpdate = vi.fn();

function render(pairing: LocalTailnetServer | null = localPairing("membership-a")) {
  root.render(
    <RemoteTeamTransport
      ref={transportRef}
      active
      localTailnetServer={pairing ?? undefined}
      accountServer={accountServer}
      directory={null}
      onConnectionUpdate={onConnectionUpdate}
      onTeamEvent={vi.fn()}
    />,
  );
}

afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  harness.instances = [];
  harness.connectBarrier = null;
  harness.session = {
    apiUrl: "https://account.example.com",
    sessionToken: "account-token",
    user: { id: "account-a" },
    localOnly: true,
  };
  onConnectionUpdate.mockClear();
  vi.mocked(loginTailnetAccountServer).mockReset();
  vi.mocked(saveLocalTailnetServer).mockReset();
});

it("disconnects the old direct socket when the host membership changes", async () => {
  harness.session = {
    apiUrl: "https://account.example.com",
    sessionToken: "account-token",
    user: { id: "account-a" },
    localOnly: true,
  };
  await act(async () => render());
  await act(async () => transportRef.current?.connect("host", "host-key"));
  expect(harness.instances).toHaveLength(1);

  await act(async () => render(localPairing("membership-b")));

  expect(harness.instances[0]?.disconnect).toHaveBeenCalledOnce();
  expect(onConnectionUpdate).toHaveBeenLastCalledWith({
    hostId: "host",
    state: "offline",
    message: "error.remote.desktopOffline",
  });
});

it("disconnects the old account socket when the account pairing changes", async () => {
  harness.session = {
    apiUrl: "https://account.example.com",
    sessionToken: "account-token",
    user: { id: "account-a" },
    localOnly: true,
  };
  await act(async () => render());
  await act(async () => transportRef.current?.connect("host", "host-key"));

  await act(async () => render(localPairing("membership-a", "account-b")));

  expect(harness.instances[0]?.disconnect).toHaveBeenCalledOnce();
});

it("disconnects a pairing when the signed-in account changes even if the pairing prop is unchanged", async () => {
  harness.session = {
    apiUrl: "https://account.example.com",
    sessionToken: "account-token",
    user: { id: "account-a" },
    localOnly: true,
  };
  await act(async () => render());
  await act(async () => transportRef.current?.connect("host", "host-key"));
  const oldClient = harness.instances[0];

  harness.session = {
    apiUrl: "https://account.example.com",
    sessionToken: "account-token-b",
    user: { id: "account-b" },
    localOnly: true,
  };
  await act(async () => render());

  expect(oldClient?.disconnect).toHaveBeenCalledOnce();
  expect(onConnectionUpdate).toHaveBeenLastCalledWith({
    hostId: "host",
    state: "offline",
    message: "error.remote.desktopOffline",
  });
});

it("does not save or reconnect an account pairing when the workspace unmounts during login", async () => {
  harness.session = {
    apiUrl: "https://account.example.com",
    sessionToken: "account-token",
    user: { id: "account-a" },
    localOnly: true,
  };
  let resolveLogin!: (server: LocalTailnetServer) => void;
  const pendingLogin = new Promise<LocalTailnetServer>((resolve) => {
    resolveLogin = resolve;
  });
  vi.mocked(loginTailnetAccountServer).mockReturnValueOnce(pendingLogin);
  await act(async () => render(null));

  let connecting: Promise<void> | undefined;
  await act(async () => {
    connecting = transportRef.current?.connect("host", "host-key");
    await Promise.resolve();
  });
  expect(loginTailnetAccountServer).toHaveBeenCalledOnce();

  await act(async () => root.unmount());
  root = createRoot(container);
  resolveLogin(localPairing("membership-a", "account-a"));
  await expect(connecting).resolves.toBeUndefined();

  expect(saveLocalTailnetServer).not.toHaveBeenCalled();
  expect(harness.instances).toHaveLength(0);
});

it("does not open events when the workspace unmounts while the direct client connects", async () => {
  harness.session = {
    apiUrl: "https://account.example.com",
    sessionToken: "account-token",
    user: { id: "account-a" },
    localOnly: true,
  };
  let resolveConnect!: () => void;
  harness.connectBarrier = new Promise<void>((resolve) => {
    resolveConnect = resolve;
  });
  await act(async () => render());

  let connecting: Promise<void> | undefined;
  await act(async () => {
    connecting = transportRef.current?.connect("host", "host-key");
    await Promise.resolve();
  });
  const client = harness.instances[0];
  expect(client).toBeDefined();

  await act(async () => root.unmount());
  root = createRoot(container);
  resolveConnect();
  await expect(connecting).resolves.toBeUndefined();

  expect(client?.disconnect).toHaveBeenCalledOnce();
  expect(client?.openEvents).not.toHaveBeenCalled();
});
