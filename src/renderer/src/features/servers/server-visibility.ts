/** The localStorage key for the servers hidden from the rail and the menu. */
export const HIDDEN_SERVER_IDS_STORAGE_KEY = "openbot.hidden-server-ids";

export interface HiddenServerIdsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads the hidden server ids. Corrupt or missing data means no hidden servers. */
export function readHiddenServerIds(storage: HiddenServerIdsStorage): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(HIDDEN_SERVER_IDS_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((entry): entry is string => typeof entry === "string"))];
}

/** Persists the hidden server ids, deduplicated. */
export function writeHiddenServerIds(storage: HiddenServerIdsStorage, ids: readonly string[]): void {
  storage.setItem(HIDDEN_SERVER_IDS_STORAGE_KEY, JSON.stringify([...new Set(ids)]));
}

export function hideServerId(ids: readonly string[], serverId: string): string[] {
  return [...new Set([...ids, serverId])];
}

export function unhideServerId(ids: readonly string[], serverId: string): string[] {
  return ids.filter((id) => id !== serverId);
}

/** A hidden server as Settings shows it for restore. */
export interface HiddenServerEntry {
  id: string;
  name: string;
}
