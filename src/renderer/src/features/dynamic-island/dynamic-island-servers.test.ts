import { describe, expect, it } from "vitest";
import { canApplyDynamicIslandServerEvent, dynamicIslandServerOrder } from "./dynamic-island-servers";

const localServer = {
  id: "local",
  kind: "local" as const,
  state: "online" as const,
  notificationsMuted: false,
};

describe("dynamic island server scope", () => {
  it("keeps the temporary local placeholder only until the first server list resolves", () => {
    expect(dynamicIslandServerOrder([], new Set(["local"]), "local", false)).toEqual(["local"]);
    expect(dynamicIslandServerOrder([], new Set(["local"]), "local", true)).toEqual([]);
  });

  it("rejects stale local events after the account has no servers", () => {
    expect(canApplyDynamicIslandServerEvent("local", [], false)).toBe(true);
    expect(canApplyDynamicIslandServerEvent("local", [], true)).toBe(false);
  });

  it("orders configured connected servers with the active server first", () => {
    const remoteServer = { ...localServer, id: "remote", kind: "remote" as const };
    expect(dynamicIslandServerOrder([localServer, remoteServer], new Set(["local", "remote"]), "remote", true)).toEqual(
      ["remote", "local"],
    );
  });
});
