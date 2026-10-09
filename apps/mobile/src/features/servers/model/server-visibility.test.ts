import { describe, expect, it, vi } from "vitest";
import {
  createServerVisibilityStore,
  decodeHiddenServerIds,
  filterVisibleServers,
  mergeVisibleServerOrder,
  type ServerVisibilityStorage,
  serverMoveAccessibility,
  serverVisibilityStorageKey,
} from "./server-visibility-core";

function memoryStorage(
  values: Record<string, string> = {},
): ServerVisibilityStorage & { values: Record<string, string> } {
  return {
    values: { ...values },
    getItem(key) {
      return this.values[key] ?? null;
    },
    setItem(key, value) {
      this.values[key] = value;
    },
  };
}

describe("mobile server visibility", () => {
  it("scopes hidden ids to the account and normalized host origin", () => {
    expect(serverVisibilityStorageKey("https://host.example/path", "user-a")).toBe(
      serverVisibilityStorageKey("https://host.example/other", "user-a"),
    );
    expect(serverVisibilityStorageKey("https://host.example", "user-a")).not.toBe(
      serverVisibilityStorageKey("https://host.example", "user-b"),
    );
    expect(serverVisibilityStorageKey("https://host.example", "user-a")).not.toBe(
      serverVisibilityStorageKey("https://other.example", "user-a"),
    );
  });

  it("decodes only unique string server ids and treats corrupt data as empty", () => {
    expect(decodeHiddenServerIds('["a","b","a",42,null]')).toEqual(["a", "b"]);
    expect(decodeHiddenServerIds("broken")).toEqual([]);
    expect(decodeHiddenServerIds("{}")).toEqual([]);
  });

  it("persists hide/show changes and notifies only the matching account", () => {
    const storage = memoryStorage();
    const store = createServerVisibilityStore(storage);
    const accountA = serverVisibilityStorageKey("https://host.example", "user-a");
    const accountB = serverVisibilityStorageKey("https://host.example", "user-b");
    const changed = vi.fn();
    const untouched = vi.fn();
    store.subscribe(accountA, changed);
    store.subscribe(accountB, untouched);

    store.hide(accountA, "server-a");
    store.hide(accountA, "server-a");
    expect(store.get(accountA)).toEqual(["server-a"]);
    expect(store.get(accountB)).toEqual([]);
    expect(JSON.parse(storage.values[accountA] ?? "[]")).toEqual(["server-a"]);
    expect(createServerVisibilityStore(storage).get(accountA)).toEqual(["server-a"]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(untouched).not.toHaveBeenCalled();

    store.show(accountA, "server-a");
    expect(store.get(accountA)).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);

    store.hide(accountA, "server-a");
    store.hide(accountA, "server-b");
    store.showAll(accountA);
    expect(store.get(accountA)).toEqual([]);
    expect(JSON.parse(storage.values[accountA] ?? "[]")).toEqual([]);
    expect(createServerVisibilityStore(storage).get(accountA)).toEqual([]);
  });

  it("does not publish a preference that failed to persist", () => {
    const storage = memoryStorage();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const store = createServerVisibilityStore(storage);
    const key = serverVisibilityStorageKey("https://host.example", "user-a");
    const changed = vi.fn();
    store.subscribe(key, changed);

    expect(() => store.hide(key, "server-a")).toThrow("storage unavailable");
    expect(store.get(key)).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps hidden server slots stable when reordering visible servers", () => {
    const allRemoteIds = ["a", "hidden", "b", "c"];
    const visibleRemoteIds = ["a", "b", "c"];
    expect(mergeVisibleServerOrder(allRemoteIds, visibleRemoteIds, ["c", "a", "b"])).toEqual(["c", "hidden", "a", "b"]);
    expect(serverMoveAccessibility(visibleRemoteIds, "c")).toEqual({ canMoveUp: true, canMoveDown: false });
  });

  it("filters only the drawer projection and leaves active/all-hidden server state intact", () => {
    const servers = [{ id: "active" }, { id: "other" }];
    expect(filterVisibleServers(servers, ["active"])).toEqual([{ id: "other" }]);
    expect(filterVisibleServers(servers, ["active", "other"])).toEqual([]);
    expect(servers).toEqual([{ id: "active" }, { id: "other" }]);
    expect(servers.find((server) => server.id === "active")?.id).toBe("active");
  });
});
