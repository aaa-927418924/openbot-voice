// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openBotUserDataDirectory, runtimeDirectory } from "./paths";

describe("standalone server paths", () => {
  it("uses the platform account-data directory without a machine-specific path", () => {
    expect(openBotUserDataDirectory({}, "/home/example", "linux")).toBe("/home/example/.config/OpenBot");
    expect(
      openBotUserDataDirectory({ APPDATA: "C:\\Users\\Example\\AppData\\Roaming" }, "C:\\Users\\Example", "win32"),
    ).toBe("C:\\Users\\Example\\AppData\\Roaming\\OpenBot");
    expect(openBotUserDataDirectory({}, "/Users/example", "darwin")).toBe(
      "/Users/example/Library/Application Support/OpenBot",
    );
  });

  it("honors portable data and runtime directory overrides", () => {
    expect(openBotUserDataDirectory({ OPENBOT_SERVER_USER_DATA: "./server-data" }, "/home/example", "linux")).toBe(
      `${process.cwd()}/server-data`,
    );
    expect(runtimeDirectory({ OPENBOT_SERVER_RUNTIME_DIR: "./server-runtime" }, "/home/example", "linux")).toBe(
      `${process.cwd()}/server-runtime`,
    );
  });

  it("uses platform cache locations for status files", () => {
    expect(runtimeDirectory({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/example", "linux")).toBe(
      "/run/user/1000/openbot-server",
    );
    expect(
      runtimeDirectory({ LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local" }, "C:\\Users\\Example", "win32"),
    ).toBe("C:\\Users\\Example\\AppData\\Local\\OpenBot\\Cache\\openbot-server");
    expect(runtimeDirectory({}, "/Users/example", "darwin")).toBe(
      "/Users/example/Library/Caches/OpenBot/openbot-server",
    );
  });
});
