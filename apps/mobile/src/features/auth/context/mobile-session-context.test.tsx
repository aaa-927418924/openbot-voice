import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mobileAnalytics } from "@/features/analytics/mobile-analytics";
import type { MobileSession } from "../api/mobile-auth";
import { MobileSessionProvider, useMobileSession } from "./mobile-session-context";

const native = vi.hoisted(() => ({
  read: vi.fn<() => Promise<MobileSession>>(),
  readIdentity: vi.fn<() => Promise<MobileSession | null>>(),
  createFallback: vi.fn<() => MobileSession>(),
  update: vi.fn<(session: MobileSession, change: { name?: string }) => Promise<MobileSession>>(),
  validate: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/features/auth/api/mobile-auth", () => ({
  MobileSessionExpiredError: class extends Error {},
  logoutMobileSession: native.signOut,
  readLocalIdentitySession: native.readIdentity,
  updateMobileProfile: native.update,
}));
vi.mock("@/features/auth/model/local-mobile-profile", () => ({
  createEphemeralLocalMobileProfile: native.createFallback,
  readLocalMobileProfile: native.read,
  updateLocalMobileProfile: native.update,
}));

const localSession: MobileSession = {
  apiUrl: "http://127.0.0.1/",
  sessionToken: "",
  localOnly: true,
  user: { id: "local-profile", email: "", name: "OpenBot", avatarUrl: null },
};
let current: ReturnType<typeof useMobileSession>;
function Account() {
  current = useMobileSession();
  return null;
}
const container = document.createElement("div");
let root = createRoot(container);

beforeEach(async () => {
  native.read.mockReset().mockResolvedValue(localSession);
  native.readIdentity.mockReset().mockResolvedValue(null);
  native.createFallback.mockReset().mockReturnValue(localSession);
  native.update.mockReset().mockImplementation(async (_session, change) => ({
    ...localSession,
    user: { ...localSession.user, name: change.name ?? localSession.user.name },
  }));
  native.validate.mockReset();
  native.signOut.mockReset();
  await act(async () =>
    root.render(
      <MobileSessionProvider>
        <Account />
      </MobileSessionProvider>,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  root = createRoot(container);
  mobileAnalytics.setEnabled(false);
});

it("loads the device profile and keeps the workspace gated without a central account", () => {
  expect(current.loading).toBe(false);
  expect(current.session).toEqual(localSession);
  expect(native.read).toHaveBeenCalledOnce();
  expect(native.validate).not.toHaveBeenCalled();
  expect(mobileAnalytics.isEnabled()).toBe(false);
});

it("restores a saved self-hosted account before opening the workspace", async () => {
  const identitySession: MobileSession = {
    apiUrl: "http://100.100.135.107:43124",
    sessionToken: "central-session",
    localOnly: true,
    user: { id: "account", email: "user@example.com", name: "User", avatarUrl: null },
  };
  await act(() => root.unmount());
  root = createRoot(container);
  native.readIdentity.mockResolvedValueOnce(identitySession);
  await act(async () => {
    root.render(
      <MobileSessionProvider>
        <Account />
      </MobileSessionProvider>,
    );
  });

  expect(current.loading).toBe(false);
  expect(current.session).toEqual(identitySession);
});

it("keeps startup gated while a saved identity session is still being restored", async () => {
  await act(() => root.unmount());
  root = createRoot(container);
  native.readIdentity.mockReturnValueOnce(new Promise<MobileSession | null>(() => {}));
  await act(async () => {
    root.render(
      <MobileSessionProvider>
        <Account />
      </MobileSessionProvider>,
    );
  });

  expect(current.loading).toBe(true);
  expect(current.session?.localOnly).toBe(true);
  expect(current.session?.user.name).toBe("OpenBot");
});

it("keeps the app usable with a temporary local profile if saved profile data cannot be read", async () => {
  await act(() => root.unmount());
  root = createRoot(container);
  native.createFallback.mockClear();
  native.readIdentity.mockRejectedValueOnce(new Error("identity server unavailable"));
  native.read.mockRejectedValueOnce(new Error("profile storage failure"));
  await act(async () => {
    root.render(
      <MobileSessionProvider>
        <Account />
      </MobileSessionProvider>,
    );
  });
  expect(current.loading).toBe(false);
  expect(current.session?.localOnly).toBe(true);
  expect(native.createFallback).toHaveBeenCalledOnce();
  expect(native.validate).not.toHaveBeenCalled();
});

it("saves profile edits locally and keeps them active in the session", async () => {
  await act(async () => current.updateProfile({ name: "Research" }));
  expect(native.update).toHaveBeenCalledWith(localSession, { name: "Research" });
  expect(current.session?.user.name).toBe("Research");
  expect(current.session?.sessionToken).toBe("");
});

it("rejects central account sessions and keeps sign-out unavailable in local-only mode", async () => {
  const accountSession = { ...localSession, localOnly: false, sessionToken: "account-token" };
  expect(() => current.connect(accountSession)).toThrow("Account sign-in is disabled");
  const sessionBefore = current.session;
  await act(async () => current.signOut());
  expect(current.session).toBe(sessionBefore);
  expect(native.signOut).not.toHaveBeenCalled();
});
