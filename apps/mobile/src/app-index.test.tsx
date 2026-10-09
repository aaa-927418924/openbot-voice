import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SplashContentReadyContext } from "@/shared/lib/use-splash-gate";
import IndexRoute from "./app/index";

const state = vi.hoisted(() => ({ authenticated: false, replace: vi.fn(), reportLayout: (): void => {} }));
vi.mock("expo-router", () => ({ router: { replace: state.replace } }));
vi.mock("react-native", () => ({
  View: ({ children, className, onLayout }: { children?: ReactNode; className?: string; onLayout?: () => void }) => {
    state.reportLayout = onLayout ?? (() => {});
    return <div className={className}>{children}</div>;
  },
}));
vi.mock("@/features/auth/context/mobile-session-context", () => ({
  useMobileSession: () => ({ session: state.authenticated ? { sessionToken: "test" } : null }),
}));
vi.mock("@/features/auth/screens/sign-in-screen", () => ({ SignInScreen: () => <p>Sign in</p> }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  state.authenticated = false;
  state.reportLayout = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

it("replaces an authenticated root route with the workspace and renders during the handoff", async () => {
  state.authenticated = true;
  const ready = vi.fn();

  await act(() =>
    root.render(
      <SplashContentReadyContext.Provider value={ready}>
        <IndexRoute />
      </SplashContentReadyContext.Provider>,
    ),
  );

  expect(state.replace).toHaveBeenCalledWith("/connected");
  expect(container.firstChild).toBeTruthy();
  state.reportLayout();
  expect(ready).toHaveBeenCalledOnce();
});

it("shows sign-in when there is no saved session", async () => {
  await act(() => root.render(<IndexRoute />));

  expect(container.textContent).toBe("Sign in");
  expect(state.replace).not.toHaveBeenCalled();
});
