// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWindowsStartupController,
  isWindowsStartupMinimized,
  WINDOWS_STARTUP_FLAG,
  windowsStartupArguments,
} from "./windows-startup";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Windows startup settings", () => {
  it("uses a private launch flag only for minimized startup", () => {
    expect(windowsStartupArguments("minimized")).toEqual([WINDOWS_STARTUP_FLAG]);
    expect(windowsStartupArguments("shown")).toEqual([]);
    expect(isWindowsStartupMinimized("win32", ["OpenBot.exe", WINDOWS_STARTUP_FLAG])).toBe(true);
    expect(isWindowsStartupMinimized("linux", [WINDOWS_STARTUP_FLAG])).toBe(false);
  });

  it("persists startup mode and registers the matching executable arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-windows-startup-"));
    temporaryDirectories.push(directory);
    const preferencePath = join(directory, "startup.json");
    let registered: { openAtLogin: boolean; args: string[] } = { openAtLogin: false, args: [] };
    let readArgs: string[] = [];
    const controller = createWindowsStartupController({
      supported: true,
      preferencePath,
      executablePath: "C:/Program Files/OpenBot/OpenBot.exe",
      getLoginItemSettings: ({ args }) => {
        readArgs = args;
        return { openAtLogin: registered.openAtLogin };
      },
      setLoginItemSettings: ({ openAtLogin, args }) => {
        registered = { openAtLogin, args };
      },
    });

    const updated = await Effect.runPromise(controller.set({ launchAtLogin: true, startupMode: "minimized" }));

    expect(updated).toEqual({ supported: true, launchAtLogin: true, startupMode: "minimized" });
    expect(registered).toEqual({ openAtLogin: true, args: [WINDOWS_STARTUP_FLAG] });
    expect(readArgs).toEqual([WINDOWS_STARTUP_FLAG]);
    expect(JSON.parse(await readFile(preferencePath, "utf8"))).toEqual({ version: 1, startupMode: "minimized" });
  });

  it("reports the controls as unavailable outside a packaged Windows build", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-windows-startup-"));
    temporaryDirectories.push(directory);
    const controller = createWindowsStartupController({
      supported: false,
      preferencePath: join(directory, "startup.json"),
      executablePath: "OpenBot",
      getLoginItemSettings: () => ({ openAtLogin: true }),
      setLoginItemSettings: () => {
        throw new Error("Should not register startup outside Windows.");
      },
    });

    await expect(Effect.runPromise(controller.get())).resolves.toEqual({
      supported: false,
      launchAtLogin: false,
      startupMode: "shown",
    });
  });
});
