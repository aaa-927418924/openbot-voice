import { desktopCall } from "./remote-desktop-effects";
import { remoteCall } from "./remote-service-effects";
// @vitest-environment node

// `HostService` is what the app binds a Team API host to an account with, and every case here is
// about which account's server it reports - not about a route. It lived in `team-api-server.test.ts`
// until the suite was split by domain, where it was the one block testing a different class.

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomicJsonFile from "../backend/atomic-json-file";
import { runCauseEffect } from "../backend/effect-boundary";
import { DEVELOPMENT_REMOTE_CLIENT_USERNAME, HostService } from "./host-service";
import { createAgents, createBrowser, createMailbox, unimplemented } from "./team-api-server-test-harness";
import { TeamStore } from "./team-store";

const roots: string[] = [];

type HostOptions = ConstructorParameters<typeof HostService>[0];
/**
 * `HostService` forwards these straight to the Team API, so the doubles above are the
 * whole harness it needs. No runtime is started here - these cases are about which
 * account's host the service is bound to.
 */
async function createHostService(
  remote: Partial<
    Pick<
      HostOptions,
      | "openRemoteDesktopSetup"
      | "listRemoteInvites"
      | "registerRemoteHost"
      | "updateRemoteHostLogo"
      | "listRemoteMembers"
      | "updateRemoteMember"
      | "removeRemoteMember"
      | "createRemoteInvite"
      | "revokeRemoteInvite"
      | "remoteControlPlaneUrl"
      | "sendTeamInviteEmail"
      | "localDevelopmentHost"
      | "localOnlyNetworking"
    >
  > = {},
  /** Supplied only by the screen recording cases, which need a runtime to hold an answer. */
  screenCaptureDenied?: () => boolean,
): Promise<{
  service: HostService;
  /** Reports an account exactly as `forwardCentralAuth` does, sign-out included. */
  signIn: (user: CentralAuthUser | null) => Promise<void>;
  /** Holds the team file, so a test can make the store's write fail. */
  root: string;
  /** The host's own team file, for what the service does not expose -- a session token's member. */
  store: TeamStore;
  /** Announces an account the way the renderer is told, before the queued switch is applied. */
  announce: (user: CentralAuthUser) => void;
}> {
  const root = await mkdtemp(join(tmpdir(), "openbot-host-service-"));
  roots.push(root);
  const store = new TeamStore(join(root, "team.json"));
  await runCauseEffect(store.initialize());
  let signedIn: CentralAuthUser | null = null;
  const options: HostOptions = {
    appVersion: "0.4.0",
    store,
    agents: { ...createAgents(), adoptConversationReads: unimplemented, searchConversationFiles: unimplemented },
    skills: { listInstalledForChatTags: unimplemented },
    sidebarLayout: {
      getSnapshot: unimplemented,
      mutate: unimplemented,
      removeAgent: unimplemented,
      withProfileAssignment: unimplemented,
      placeDuplicateAfter: unimplemented,
      on: () => undefined,
      off: () => undefined,
    },
    mailbox: createMailbox(),
    browser: createBrowser(),
    getSignedInUser: () => {
      if (!signedIn) throw new Error("No account is signed in.");
      return signedIn;
    },
    redeemCentralTicket: unimplemented,
    sendTeamInviteEmail: unimplemented,
    ...(screenCaptureDenied
      ? {
          platform: "darwin" as const,
          remoteDesktopRuntimePaths: {
            sunshine: "/runtime/Sunshine.app/Contents/MacOS/Sunshine",
            moonlightWebServer: "/web",
            moonlightStreamer: "/stream",
          },
          createRemoteDesktopRuntime: () => ({
            start: () =>
              desktopCall(async () => ({
                baseUrl: "http://127.0.0.1:9",
                authHeader: "X-Test-Remote",
                hostId: 1,
                hostIds: [1],
                desktopAppId: 1,
                displays: [],
                selectedDisplayId: null,
              })),
            selectDisplay: () => desktopCall(async () => undefined),
            stop: () => desktopCall(async () => undefined),
            screenCaptureDenied,
          }),
        }
      : {}),
    ...remote,
  };
  const service = new HostService(options);
  return {
    service,
    root,
    store,
    announce: (user) => {
      signedIn = user;
    },
    signIn: async (user) => {
      signedIn = user;
      await runCauseEffect(service.applySignedInAccount(user));
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type RemoteInvites = Effect.Success<ReturnType<NonNullable<HostOptions["listRemoteInvites"]>>>;
type RemoteMembers = Effect.Success<ReturnType<NonNullable<HostOptions["listRemoteMembers"]>>>;
type RemoteInvite = Effect.Success<ReturnType<NonNullable<HostOptions["createRemoteInvite"]>>>;

// The gateway holds the refusal, and this status is the only way it reaches the host owner's screen.
// A member who is refused cannot grant anything: they are on the other computer.
describe.runIf(process.platform === "darwin")("HostService permission setup", () => {
  it.each(["accessibility", "screen-recording", "reveal"] as const)("opens Sunshine setup for %s", async (action) => {
    const openRemoteDesktopSetup = vi.fn(() => remoteCall(async () => undefined));
    const { service } = await createHostService({ openRemoteDesktopSetup }, () => false);
    await runCauseEffect(service.openRemoteDesktopSetup(action));
    expect(openRemoteDesktopSetup).toHaveBeenCalledWith(action, "/runtime/Sunshine.app");
  });
});

describe("HostService screen recording", () => {
  it("reports the refusal the gateway holds, and says the status changed", async () => {
    let denied = true;
    const { service } = await createHostService({}, () => denied);
    expect(service.getStatus().remoteDesktopScreenRecordingDenied).toBe(false);
    const changed = vi.fn();
    service.on("changed", changed);

    await expect(runCauseEffect(service.recheckScreenRecording())).resolves.toMatchObject({
      remoteDesktopScreenRecordingDenied: true,
    });
    expect(service.getStatus().remoteDesktopScreenRecordingDenied).toBe(true);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ remoteDesktopScreenRecordingDenied: true }));

    denied = false;
    await expect(runCauseEffect(service.recheckScreenRecording())).resolves.toMatchObject({
      remoteDesktopScreenRecordingDenied: false,
    });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ remoteDesktopScreenRecordingDenied: false }));
  });
});

describe("HostService account binding", () => {
  const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
  const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };
  const third = { id: "account-c", email: "c@example.com", name: "C", avatarUrl: null };

  it("configures an account-owned local host and prevents another account from adopting it", async () => {
    const registerRemoteHost = vi.fn(() => remoteCall(async () => undefined));
    const { service, store, signIn } = await createHostService({ localOnlyNetworking: true, registerRemoteHost });

    await signIn(first);
    const status = await runCauseEffect(service.configure({ serverName: "Tailnet host" }));
    expect(status).toMatchObject({ configured: true, serverName: "Tailnet host", phase: "idle" });
    expect(store.getOwnerAccountId()).toBe(first.id);
    expect(store.listMembers()).toHaveLength(1);
    expect(store.listMembers()[0]).toMatchObject({ username: "owner", email: null, role: "owner" });
    const ownerId = store.getOwnerMemberId();
    expect(ownerId).toBeTruthy();
    const invite = await runCauseEffect(store.createInvite("member"));
    const { member } = await runCauseEffect(store.acceptInvite(invite.token, "android-device", "member-password"));
    await runCauseEffect(service.updateMember({ memberId: member.id, channelIdentityId: ownerId }));
    expect(store.getChannelIdentity(member.id)?.id).toBe(ownerId);
    expect(await runCauseEffect(service.listMembers())).toContainEqual(
      expect.objectContaining({ id: member.id, channelIdentityId: ownerId }),
    );
    await expect(runCauseEffect(service.updateIdentity({ serverName: "Renamed host" }))).resolves.toMatchObject({
      serverName: "Renamed host",
    });
    expect(registerRemoteHost).not.toHaveBeenCalled();

    await runCauseEffect(store.activateAccount(second));
    await expect(runCauseEffect(store.activateLocalHost(second.id, second.email))).resolves.toBe(false);
    expect(store.configured).toBe(false);
  });

  it("renames the saved account host when the visible host status is temporarily unconfigured", async () => {
    const { service, store, signIn } = await createHostService({ localOnlyNetworking: true });
    await signIn(first);
    await expect(runCauseEffect(service.configure({ serverName: "OpenBot" }))).resolves.toMatchObject({
      configured: true,
      serverName: "OpenBot",
    });
    const originalServerId = store.getIdentity()?.serverId;

    // Account changes clear the active selection before the next host is applied. The existing
    // account-owned host remains on disk and must be selected instead of being configured again.
    service.unbindChangedAccount(null);
    expect(service.getStatus().configured).toBe(false);

    await expect(runCauseEffect(service.configure({ serverName: "Renamed OpenBot" }))).resolves.toMatchObject({
      configured: true,
      serverName: "Renamed OpenBot",
    });
    expect(store.getIdentity()).toMatchObject({ serverId: originalServerId, serverName: "Renamed OpenBot" });
    expect(store.getOwnerAccountId()).toBe(first.id);
  });

  it("keeps the first host for its owner and lets the newly signed-in account configure after a delayed write", async () => {
    const { service, store, signIn, announce, root } = await createHostService({ localOnlyNetworking: true });
    await signIn(first);

    let markWriteStarted: () => void = () => undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite: () => void = () => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const path = join(root, "team.json");
    const writeFileAtomically = atomicJsonFile.writeFileAtomically;
    const writeSpy = vi.spyOn(atomicJsonFile, "writeFileAtomically");
    let delayFirstWrite = true;
    writeSpy.mockImplementation((targetPath, content, options) => {
      if (targetPath !== path || !delayFirstWrite) return writeFileAtomically(targetPath, content, options);
      delayFirstWrite = false;
      return Effect.tryPromise({
        try: async () => {
          markWriteStarted();
          await writeGate;
          await Effect.runPromise(writeFileAtomically(targetPath, content, options));
        },
        catch: (cause) => new atomicJsonFile.AtomicFileWriteError({ operation: "write", cause }),
      });
    });

    const pendingSetup = runCauseEffect(service.configure({ serverName: "Account A host" }));
    await writeStarted;
    // Central auth has announced B, but its asynchronous account-switch callback has not
    // recorded B in the local TeamStore yet.
    announce(second);
    releaseWrite();
    await expect(pendingSetup).rejects.toThrow();

    await expect(runCauseEffect(service.configure({ serverName: "Account B host" }))).resolves.toMatchObject({
      configured: true,
      serverName: "Account B host",
    });

    const saved: {
      activeAccountId: string | null;
      hosts: Array<{ serverName: string }>;
    } = JSON.parse(await readFile(path, "utf8"));
    expect(saved.activeAccountId).toBe(second.id);
    expect(saved.hosts.map((host) => host.serverName).sort()).toEqual(["Account A host", "Account B host"]);
    expect(store.getOwnerAccountId()).toBe(second.id);
  });

  it("restores the latest account when sign-in changes twice during selection writes", async () => {
    const { service, signIn, announce, root } = await createHostService({ localOnlyNetworking: true });
    await signIn(first);

    const path = join(root, "team.json");
    const writeFileAtomically = atomicJsonFile.writeFileAtomically;
    const writeSpy = vi.spyOn(atomicJsonFile, "writeFileAtomically");
    let markHostWriteStarted: () => void = () => undefined;
    const hostWriteStarted = new Promise<void>((resolve) => {
      markHostWriteStarted = resolve;
    });
    let releaseHostWrite: () => void = () => undefined;
    const hostWriteGate = new Promise<void>((resolve) => {
      releaseHostWrite = resolve;
    });
    let markSecondSelectionStarted: () => void = () => undefined;
    const secondSelectionStarted = new Promise<void>((resolve) => {
      markSecondSelectionStarted = resolve;
    });
    let releaseSecondSelection: () => void = () => undefined;
    const secondSelectionGate = new Promise<void>((resolve) => {
      releaseSecondSelection = resolve;
    });
    let delayedHostWrite = false;
    let delayedSecondSelection = false;
    writeSpy.mockImplementation((targetPath, content, options) => {
      if (targetPath !== path) return writeFileAtomically(targetPath, content, options);
      if (!delayedHostWrite) {
        delayedHostWrite = true;
        return Effect.tryPromise({
          try: async () => {
            markHostWriteStarted();
            await hostWriteGate;
            await Effect.runPromise(writeFileAtomically(targetPath, content, options));
          },
          catch: (cause) => new atomicJsonFile.AtomicFileWriteError({ operation: "write", cause }),
        });
      }
      if (!delayedSecondSelection && String(content).includes('"activeAccountId":"account-b"')) {
        delayedSecondSelection = true;
        return Effect.tryPromise({
          try: async () => {
            markSecondSelectionStarted();
            await secondSelectionGate;
            await Effect.runPromise(writeFileAtomically(targetPath, content, options));
          },
          catch: (cause) => new atomicJsonFile.AtomicFileWriteError({ operation: "write", cause }),
        });
      }
      return writeFileAtomically(targetPath, content, options);
    });

    const pendingSetup = runCauseEffect(service.configure({ serverName: "Account A host" }));
    await hostWriteStarted;
    announce(second);
    releaseHostWrite();
    await secondSelectionStarted;
    // The second selection write can finish after a still newer login has been announced.
    announce(third);
    releaseSecondSelection();
    await expect(pendingSetup).rejects.toThrow();

    await expect(runCauseEffect(service.configure({ serverName: "Account C host" }))).resolves.toMatchObject({
      configured: true,
      serverName: "Account C host",
    });
    const saved: { activeAccountId: string | null; hosts: Array<{ serverName: string }> } = JSON.parse(
      await readFile(path, "utf8"),
    );
    expect(saved.activeAccountId).toBe(third.id);
    expect(saved.hosts.map((host) => host.serverName).sort()).toEqual(["Account A host", "Account C host"]);
  });

  it("clears the stale selection if restoring the newly signed-in account fails once", async () => {
    const { service, signIn, announce, root } = await createHostService({ localOnlyNetworking: true });
    await signIn(first);

    let markWriteStarted: () => void = () => undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite: () => void = () => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const path = join(root, "team.json");
    const writeFileAtomically = atomicJsonFile.writeFileAtomically;
    const writeSpy = vi.spyOn(atomicJsonFile, "writeFileAtomically");
    let writeNumber = 0;
    writeSpy.mockImplementation((targetPath, content, options) => {
      if (targetPath !== path) return writeFileAtomically(targetPath, content, options);
      writeNumber += 1;
      if (writeNumber === 1) {
        return Effect.tryPromise({
          try: async () => {
            markWriteStarted();
            await writeGate;
            await Effect.runPromise(writeFileAtomically(targetPath, content, options));
          },
          catch: (cause) => new atomicJsonFile.AtomicFileWriteError({ operation: "write", cause }),
        });
      }
      if (writeNumber === 2) {
        return Effect.fail(
          new atomicJsonFile.AtomicFileWriteError({ operation: "write", cause: new Error("temporary failure") }),
        );
      }
      return writeFileAtomically(targetPath, content, options);
    });

    const pendingSetup = runCauseEffect(service.configure({ serverName: "Account A host" }));
    await writeStarted;
    announce(second);
    releaseWrite();
    await expect(pendingSetup).rejects.toThrow();

    const savedAfterRecovery: { activeAccountId: string | null; hosts: Array<{ serverName: string }> } = JSON.parse(
      await readFile(path, "utf8"),
    );
    expect(savedAfterRecovery.activeAccountId).toBeNull();
    expect(savedAfterRecovery.hosts.map((host) => host.serverName)).toEqual(["Account A host"]);

    await expect(runCauseEffect(service.configure({ serverName: "Account B host" }))).resolves.toMatchObject({
      configured: true,
      serverName: "Account B host",
    });
  });

  it("refuses to start an account-owned local host after another account signs in", async () => {
    const { service, store, announce } = await createHostService({ localOnlyNetworking: true });
    await runCauseEffect(store.configure("Tailnet host", "owner", "owner password", first.id));
    await runCauseEffect(store.syncSelfHostedOwner(first));
    await runCauseEffect(store.activateLocalHost(first.id));
    announce(second);

    await expect(runCauseEffect(service.start())).rejects.toThrow();
    expect(service.getStatus().phase).not.toBe("online");
  });

  it("uses the local caller for channels without requiring a cloud account", async () => {
    const { service, announce } = await createHostService();
    expect(service.channelActor()).toEqual({ id: "local", name: "You" });
    announce(first);
    expect(service.channelActor()).toEqual({ id: "local-user:account-a", name: "A" });
    announce(second);
    expect(service.channelActor()).toEqual({ id: "local-user:account-b", name: "B" });
  });

  it("reports the membership bound to the signed-in account as the local reader", async () => {
    const { service, store, announce } = await createHostService();
    await runCauseEffect(store.configureWithAccount("Studio Mac", first));
    announce(first);

    expect(service.getPresence().readerMemberId).toBe(store.getOwnerMemberId());
  });

  it("stops reporting the previous account's server when the account changes", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    await runCauseEffect(service.configure({ serverName: "Studio Mac" }));
    expect(service.getStatus().serverName).toBe("Studio Mac");

    await signIn(second);

    const status = service.getStatus();
    expect(status.configured).toBe(false);
    expect(status.phase).toBe("unconfigured");
    expect(status.serverId).toBeNull();
    expect(status.serverName).toBeNull();
    expect(status.enabledOnLaunch).toBe(false);
  });

  it("stops reporting the previous account's server before the switch is recorded", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    await runCauseEffect(service.configure({ serverName: "Studio Mac" }));

    // What `forwardCentralAuth` calls before it tells the renderer the account changed.
    service.unbindChangedAccount(second);

    expect(service.getStatus().configured).toBe(false);
    expect(service.getStatus().serverId).toBeNull();
    expect(service.getStatus().serverName).toBeNull();
  });

  it("puts the account's server back when the same account is reported after the unbind", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    const identity = await runCauseEffect(service.configure({ serverName: "Studio Mac" }));

    // A sign-out and an immediate sign-in as the same account: the unbind lands first, and
    // the queued switch that follows is the only thing that can bind the host again.
    service.unbindChangedAccount(second);
    await signIn(first);

    expect(service.getStatus().configured).toBe(true);
    expect(service.getStatus().serverId).toBe(identity.serverId);
    expect(service.getStatus().serverName).toBe("Studio Mac");
  });

  it("does not bind the previous account's server when its switch is applied too late", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    await runCauseEffect(service.configure({ serverName: "Studio Mac" }));
    await signIn(second);

    // A's queued switch, arriving after B is the signed-in account.
    await runCauseEffect(service.applySignedInAccount(first));

    expect(service.getStatus().configured).toBe(false);
    await expect(runCauseEffect(service.listMembers())).rejects.toThrow("The team server is not configured.");
  });

  it("answers invitations from the host that is active when the read returns", async () => {
    let deliver: (invites: RemoteInvites) => void = () => undefined;
    const loading = new Promise<RemoteInvites>((resolve) => {
      deliver = resolve;
    });
    const { service, signIn } = await createHostService({
      remoteControlPlaneUrl: "https://api.openbot.run",
      listRemoteInvites: () => remoteCall(async () => loading),
    });
    await signIn(second);
    await runCauseEffect(service.configure({ serverName: "Studio Air" }));
    await signIn(first);
    await runCauseEffect(service.configure({ serverName: "Studio Mac" }));

    const pending = runCauseEffect(service.listInvites());
    await signIn(second);
    deliver([
      {
        inviteId: "invite-1",
        role: "member",
        email: "invited-by-a@example.com",
        expiresAt: Date.now() + 60_000,
        usedAt: null,
        revokedAt: null,
        permanent: false,
        useCount: 0,
      },
    ]);

    // A's invitation, and the address it was sent to, must not reach B's renderer.
    await expect(pending).resolves.toEqual([]);
  });

  it("keeps a local development host's members and invitations in its own team file", async () => {
    const remoteCalls: string[] = [];
    const { service, signIn, store } = await createHostService({
      localDevelopmentHost: true,
      remoteControlPlaneUrl: "http://127.0.0.1:8787",
      listRemoteInvites: () =>
        remoteCall(async () => {
          remoteCalls.push("list invites");
          return [];
        }),
      revokeRemoteInvite: () =>
        remoteCall(async () => {
          remoteCalls.push("revoke invite");
        }),
      listRemoteMembers: () =>
        remoteCall(async () => {
          remoteCalls.push("list members");
          return [];
        }),
      updateRemoteMember: () =>
        remoteCall(async () => {
          remoteCalls.push("update member");
        }),
      removeRemoteMember: () =>
        remoteCall(async () => {
          remoteCalls.push("remove member");
        }),
    });
    await signIn(first);
    await runCauseEffect(service.configure({ serverName: "Studio Mac" }));
    const invite = await runCauseEffect(store.createInvite("member", "guest@example.com", { permanent: false }));

    expect(await runCauseEffect(service.listInvites())).toEqual([expect.objectContaining({ id: invite.id })]);
    await runCauseEffect(service.revokeInvite(invite.id));
    expect(await runCauseEffect(service.listInvites())).toEqual([]);

    const joined = await runCauseEffect(store.createInvite("member"));
    const { member } = await runCauseEffect(store.acceptInvite(joined.token, "guest", "guest-password"));
    expect(await runCauseEffect(service.listMembers())).toContainEqual(
      expect.objectContaining({ id: member.id, role: "member" }),
    );
    await runCauseEffect(service.updateMember({ memberId: member.id, role: "admin" }));
    expect(await runCauseEffect(service.listMembers())).toContainEqual(
      expect.objectContaining({ id: member.id, role: "admin" }),
    );
    await runCauseEffect(service.removeMember(member.id));

    expect((await runCauseEffect(service.listMembers())).map((listed) => listed.id)).not.toContain(member.id);
    expect(remoteCalls).toEqual([]);
  });

  it("does not push a server update to the remote directory once the account has changed", async () => {
    let finishRegistration: () => void = () => undefined;
    const registered = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    let registrationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    const logos: string[] = [];
    const { service, signIn } = await createHostService({
      // Naming the server registers it too; only the update's registration is held open.
      registerRemoteHost: (input) =>
        remoteCall(async () => {
          if (input.name !== "Renamed") return Promise.resolve();
          registrationStarted();
          return registered;
        }),
      updateRemoteHostLogo: (hostId) =>
        remoteCall(async () => {
          logos.push(hostId);
          return null;
        }),
    });
    await signIn(first);
    await runCauseEffect(service.configure({ serverName: "Studio Mac" }));

    const pending = runCauseEffect(
      service.updateIdentity({
        serverName: "Renamed",
        logo: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      }),
    );
    // The store's own guard covers the window up to here; this is the one after it.
    await started;
    await signIn(second);
    finishRegistration();
    await pending;

    // Uploading it here would send A's image under B's authentication.
    expect(logos).toEqual([]);
  });

  it("does not change a member on the previous account's server once the account has changed", async () => {
    let releaseRead: (members: RemoteMembers) => void = () => undefined;
    const reading = new Promise<RemoteMembers>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let reads = 0;
    const mutations: string[] = [];
    const { service, signIn } = await createHostService({
      listRemoteMembers: () =>
        remoteCall(async () => {
          reads += 1;
          readStarted();
          return reading;
        }),
      updateRemoteMember: (hostId) =>
        remoteCall(async () => {
          mutations.push(hostId);
        }),
      removeRemoteMember: (hostId) =>
        remoteCall(async () => {
          mutations.push(hostId);
        }),
      registerRemoteHost: () => remoteCall(async () => Promise.resolve()),
    });
    await signIn(first);
    await runCauseEffect(service.configure({ serverName: "Studio Mac" }));

    const pending = runCauseEffect(service.updateMember({ memberId: "member-1", role: "admin" }));
    const settled = pending.catch(() => undefined);
    await started;
    await signIn(second);
    releaseRead([
      {
        membershipId: "member-1",
        email: "person@example.com",
        name: null,
        avatarUrl: null,
        role: "member",
        status: "active",
        createdAt: 1_000,
      },
    ]);
    await settled;

    await expect(pending).rejects.toThrow("signed-in account changed");
    // The mutation would have carried B's authorization to A's host.
    expect(mutations).toEqual([]);
    expect(reads).toBe(1);
  });

  it("leaves the new account's status alone when the previous account's registration fails", async () => {
    let failRegistration: (error: Error) => void = () => undefined;
    const registration = new Promise<void>((_resolve, reject) => {
      failRegistration = reject;
    });
    let registrationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    const { service, signIn } = await createHostService({
      registerRemoteHost: () =>
        remoteCall(async () => {
          registrationStarted();
          return registration;
        }),
    });
    await signIn(first);

    const pending = runCauseEffect(service.configure({ serverName: "Studio Mac" }));
    await started;
    await signIn(second);
    const beforeFailure = service.getStatus();
    failRegistration(new Error("Could not reserve the public address."));
    await pending;

    // B has no server of its own; A's failure must not paint an error over that.
    expect(service.getStatus()).toEqual(beforeFailure);
    expect(service.getStatus().phase).not.toBe("error");
  });

  it("does not email an invitation created for the account that has just been left", async () => {
    let releaseInvite: (invite: RemoteInvite) => void = () => undefined;
    const creating = new Promise<RemoteInvite>((resolve) => {
      releaseInvite = resolve;
    });
    let creationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const emails: string[] = [];
    const { service, signIn } = await createHostService({
      registerRemoteHost: () => remoteCall(async () => Promise.resolve()),
      remoteControlPlaneUrl: "https://api.openbot.run",
      createRemoteInvite: () =>
        remoteCall(async () => {
          creationStarted();
          return creating;
        }),
      sendTeamInviteEmail: ({ email }) =>
        remoteCall(async () => {
          emails.push(email);
        }),
    });
    await signIn(first);
    await runCauseEffect(service.configure({ serverName: "Studio Mac" }));

    const pending = runCauseEffect(service.createInvite({ role: "member", email: "guest@example.com" }));
    const settled = pending.catch(() => undefined);
    await started;
    await signIn(second);
    releaseInvite({
      inviteId: "invite-1",
      token: "invite-token-that-is-long-enough-for-a-link",
      expiresAt: Date.now() + 60_000,
      permanent: false,
      useCount: 0,
    });
    await settled;

    await expect(pending).rejects.toThrow("signed-in account changed");
    // The mail would name A's server and go out under B's authentication.
    expect(emails).toEqual([]);
  });

  it("activates the account again after a failed switch instead of leaving it unconfigured", async () => {
    const { service, signIn, root } = await createHostService({
      registerRemoteHost: () => remoteCall(async () => Promise.resolve()),
    });
    await signIn(first);
    await runCauseEffect(service.configure({ serverName: "Studio Mac" }));
    await signIn(second);
    const secondIdentity = await runCauseEffect(service.configure({ serverName: "Loft Mini" }));
    await signIn(first);

    // The team file cannot be written while its directory is gone, so recording the switch fails.
    await rm(root, { recursive: true, force: true });
    await expect(signIn(second)).rejects.toThrow();
    expect(service.getStatus().configured).toBe(false);

    await mkdir(root, { recursive: true });
    await signIn(second);
    expect(service.getStatus().serverId).toBe(secondIdentity.serverId);
    expect(service.getStatus().configured).toBe(true);
  });

  it("does not create the previous account's server once another account has been announced", async () => {
    const registrations: string[] = [];
    const { service, signIn, announce } = await createHostService({
      registerRemoteHost: ({ hostId }) =>
        remoteCall(async () => {
          registrations.push(hostId);
        }),
    });
    await signIn(first);

    const pending = runCauseEffect(
      service.configure({
        serverName: "Studio Mac",
        logo: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      }),
    );
    // Announced while the logo and the host are being written, with the switch itself queued.
    announce(second);

    await expect(pending).rejects.toThrow("signed-in account changed");
    expect(service.getStatus().configured).toBe(false);
    // Registering would have reserved A's server under B's authentication.
    expect(registrations).toEqual([]);
    // Nor may what was created stay readable: the owner's address is in there.
    await expect(runCauseEffect(service.listMembers())).rejects.toThrow("The team server is not configured.");
  });

  it("hands the development client a working session after the directory disabled it", async () => {
    const { service, signIn, store } = await createHostService({
      registerRemoteHost: () => remoteCall(async () => Promise.resolve()),
      listRemoteMembers: () =>
        remoteCall(async () => [
          {
            membershipId: "membership-owner",
            email: first.email,
            name: first.name,
            avatarUrl: null,
            role: "owner",
            status: "active",
            createdAt: 1_000,
          },
        ]),
    });
    await signIn(first);
    await runCauseEffect(service.configure({ serverName: "Studio Mac" }));
    await runCauseEffect(service.startDevelopmentLocal());
    await runCauseEffect(service.createDevelopmentConnection());

    // What publishing this host does to it: the control plane becomes the whole membership, and the
    // technical development client -- password-only, owned by no account -- is not in that list.
    await runCauseEffect(service.listMembers());

    const reconnected = await runCauseEffect(service.createDevelopmentConnection());
    expect(store.authenticate(reconnected.sessionToken)?.username).toBe(DEVELOPMENT_REMOTE_CLIENT_USERNAME);
    await runCauseEffect(service.stop(false));
  });

  it("reports the account's own server again after signing out and back in", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    const identity = await runCauseEffect(service.configure({ serverName: "Studio Mac" }));

    await signIn(null);
    expect(service.getStatus().configured).toBe(false);
    expect(service.getStatus().serverId).toBeNull();

    await signIn(first);
    expect(service.getStatus().serverId).toBe(identity.serverId);
    expect(identity.serverId).not.toBeNull();
    expect(service.getStatus().serverName).toBe("Studio Mac");
  });
});
