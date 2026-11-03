import { describe, expect, it } from "vitest";
import {
  isOpenBotCloudHost,
  readOpenBotCloudHostPort,
  resolveOpenBotDataRoot,
  shouldStartOpenBotCloudHostHidden,
} from "./openbot-runtime-config";

describe("OpenBot cloud-host runtime configuration", () => {
  it("enables the cloud-host mode only on Linux when explicitly requested", () => {
    expect(isOpenBotCloudHost({ OPENBOT_CLOUD_HOST: "1" }, "linux")).toBe(true);
    expect(isOpenBotCloudHost({ OPENBOT_CLOUD_HOST: "1" }, "win32")).toBe(false);
    expect(isOpenBotCloudHost({}, "linux")).toBe(false);
  });

  it("keeps the cloud host hidden by default but allows its GUI on request", () => {
    expect(shouldStartOpenBotCloudHostHidden({ OPENBOT_CLOUD_HOST: "1" })).toBe(true);
    expect(shouldStartOpenBotCloudHostHidden({ OPENBOT_CLOUD_HOST: "1", OPENBOT_CLOUD_HOST_SHOW_UI: "1" })).toBe(false);
    expect(shouldStartOpenBotCloudHostHidden({ OPENBOT_CLOUD_HOST_SHOW_UI: "1" })).toBe(false);
  });

  it("keeps an alternate data root outside the regular local server root", () => {
    expect(resolveOpenBotDataRoot("/home/aaa", "/home/aaa/OpenBotCloud/data")).toBe("/home/aaa/OpenBotCloud/data");
    expect(() => resolveOpenBotDataRoot("/home/aaa", "OpenBotCloud")).toThrow("absolute path");
    expect(() => resolveOpenBotDataRoot("/home/aaa", "/home/aaa/OpenBot/Cloud")).toThrow("separate");
    expect(() => resolveOpenBotDataRoot("/home/aaa", "/home/aaa")).toThrow("separate");
  });

  it("uses the standard Team API port unless a valid alternate port is set", () => {
    expect(readOpenBotCloudHostPort({})).toBe(43123);
    expect(readOpenBotCloudHostPort({ OPENBOT_TEAM_API_PORT: "43125" })).toBe(43125);
    expect(() => readOpenBotCloudHostPort({ OPENBOT_TEAM_API_PORT: "abc" })).toThrow("integer");
    expect(() => readOpenBotCloudHostPort({ OPENBOT_TEAM_API_PORT: "80" })).toThrow("integer");
    expect(() => readOpenBotCloudHostPort({ OPENBOT_TEAM_API_PORT: "65536" })).toThrow("integer");
  });
});
