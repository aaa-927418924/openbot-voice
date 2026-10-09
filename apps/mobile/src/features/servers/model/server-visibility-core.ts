import { remoteHostFingerprint } from "@openbot/team-client";

export interface ServerVisibilityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function serverVisibilityStorageKey(apiUrl: string, userId: string): string {
  const scope = remoteHostFingerprint(JSON.stringify([new URL(apiUrl).origin, userId]));
  return `openbot.mobile-hidden-server-ids.v1.${scope}`;
}

export function decodeHiddenServerIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) satisfies unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((entry): entry is string => typeof entry === "string"))]
      : [];
  } catch {
    return [];
  }
}

/** Keep hidden servers in their current slots while the drawer reorders visible servers. */
export function mergeVisibleServerOrder(
  currentRemoteIds: readonly string[],
  visibleIds: readonly string[],
  nextVisibleIds: readonly string[],
): string[] {
  const visible = new Set(visibleIds);
  let nextIndex = 0;
  return currentRemoteIds.map((id) => {
    if (!visible.has(id)) return id;
    const next = nextVisibleIds[nextIndex];
    nextIndex += 1;
    return next ?? id;
  });
}

/** Filter only the drawer projection; callers keep the full server roster for workspace state. */
export function filterVisibleServers<T extends { id: string }>(
  servers: readonly T[],
  hiddenServerIds: readonly string[],
): T[] {
  const hidden = new Set(hiddenServerIds);
  return servers.filter((server) => !hidden.has(server.id));
}

export function serverMoveAccessibility(remoteIds: readonly string[], serverId: string) {
  const index = remoteIds.indexOf(serverId);
  return {
    canMoveUp: index > 0,
    canMoveDown: index >= 0 && index < remoteIds.length - 1,
  };
}

interface ServerVisibilityEntry {
  ids: readonly string[];
  listeners: Set<() => void>;
}

export interface ServerVisibilityStore {
  get: (key: string) => readonly string[];
  subscribe: (key: string, listener: () => void) => () => void;
  hide: (key: string, serverId: string) => void;
  show: (key: string, serverId: string) => void;
  showAll: (key: string) => void;
}

export function createServerVisibilityStore(storage: ServerVisibilityStorage): ServerVisibilityStore {
  const entries = new Map<string, ServerVisibilityEntry>();
  function entry(key: string): ServerVisibilityEntry {
    let current = entries.get(key);
    if (!current) {
      let stored: string | null = null;
      try {
        stored = storage.getItem(key);
      } catch {
        // A local display preference must not prevent the workspace from opening.
      }
      current = { ids: decodeHiddenServerIds(stored), listeners: new Set() };
      entries.set(key, current);
    }
    return current;
  }

  function write(key: string, ids: readonly string[]) {
    const next = [...new Set(ids)];
    const current = entry(key);
    if (current.ids.length === next.length && current.ids.every((id, index) => id === next[index])) return;
    storage.setItem(key, JSON.stringify(next));
    current.ids = next;
    for (const listener of current.listeners) listener();
  }

  return {
    get: (key) => entry(key).ids,
    subscribe: (key, listener) => {
      const current = entry(key);
      current.listeners.add(listener);
      return () => current.listeners.delete(listener);
    },
    hide: (key, serverId) => write(key, [...entry(key).ids, serverId]),
    show: (key, serverId) =>
      write(
        key,
        entry(key).ids.filter((id) => id !== serverId),
      ),
    showAll: (key) => write(key, []),
  };
}
