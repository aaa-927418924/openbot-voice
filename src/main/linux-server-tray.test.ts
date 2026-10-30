// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { appEvents, execFileMock, trayEvents, trayMock } = vi.hoisted(() => ({
  appEvents: new Map<string, (...args: unknown[]) => void>(),
  execFileMock: vi.fn(),
  trayEvents: new Map<string, (...args: unknown[]) => void>(),
  trayMock: {
    destroy: vi.fn(),
    setContextMenu: vi.fn(),
    setToolTip: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    on: (event: string, handler: (...args: unknown[]) => void) => appEvents.set(event, handler),
    quit: vi.fn(),
    setName: vi.fn(),
  },
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: {
    createEmpty: vi.fn(() => ({})),
    createFromPath: vi.fn(() => ({ isEmpty: () => true })),
  },
  Tray: class {
    destroy = trayMock.destroy;
    setContextMenu = trayMock.setContextMenu;
    setToolTip = trayMock.setToolTip;
    on = (event: string, handler: (...args: unknown[]) => void) => trayEvents.set(event, handler);
  },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

import { startLinuxServerTray } from "./linux-server-tray";

const roots: string[] = [];

afterEach(async () => {
  appEvents.clear();
  trayEvents.clear();
  trayMock.destroy.mockClear();
  trayMock.setContextMenu.mockClear();
  trayMock.setToolTip.mockClear();
  execFileMock.mockClear();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Linux OpenBot server tray", () => {
  it("opens the management TUI on a single tray click", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-server-tray-test-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    const home = join(root, "home");
    const executable = join(home, ".local", "bin", "openbot-server-local");
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
    vi.stubEnv("OPENBOT_SERVER_RUNTIME_DIR", runtime);
    vi.stubEnv("HOME", home);

    await startLinuxServerTray();
    const click = trayEvents.get("click");
    expect(click).toBeTypeOf("function");
    click?.();

    expect(execFileMock).toHaveBeenCalledWith(
      "x-terminal-emulator",
      ["-e", executable, "tui"],
      expect.objectContaining({ env: expect.objectContaining({ OPENBOT_SERVER_RUNTIME_DIR: runtime }) }),
      expect.any(Function),
    );
    appEvents.get("before-quit")?.();
  });
});
