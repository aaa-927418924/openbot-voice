// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  HIDDEN_SERVER_IDS_STORAGE_KEY,
  hideServerId,
  readHiddenServerIds,
  unhideServerId,
  writeHiddenServerIds,
} from "./server-visibility";

function memoryStorage(values: Record<string, string> = {}) {
  const store = { ...values };
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    store,
  };
}

describe("server visibility", () => {
  it("reads an empty list when nothing is stored", () => {
    expect(readHiddenServerIds(memoryStorage())).toEqual([]);
  });

  it("reads stored ids and drops corrupt data", () => {
    expect(readHiddenServerIds(memoryStorage({ [HIDDEN_SERVER_IDS_STORAGE_KEY]: '["a","b"]' }))).toEqual(["a", "b"]);
    expect(readHiddenServerIds(memoryStorage({ [HIDDEN_SERVER_IDS_STORAGE_KEY]: "broken" }))).toEqual([]);
    expect(readHiddenServerIds(memoryStorage({ [HIDDEN_SERVER_IDS_STORAGE_KEY]: '["a",42,null]' }))).toEqual(["a"]);
  });

  it("persists ids deduplicated", () => {
    const storage = memoryStorage();
    writeHiddenServerIds(storage, ["a", "a", "b"]);
    expect(storage.store[HIDDEN_SERVER_IDS_STORAGE_KEY] ?? "").toBe('["a","b"]');
  });

  it("hides and unhides one id", () => {
    expect(hideServerId([], "a")).toEqual(["a"]);
    expect(hideServerId(["a"], "a")).toEqual(["a"]);
    expect(unhideServerId(["a", "b"], "a")).toEqual(["b"]);
  });
});
