import * as SecureStore from "expo-secure-store";
import { useCallback, useSyncExternalStore } from "react";
import { createServerVisibilityStore, serverVisibilityStorageKey } from "./server-visibility-core";

export type { ServerVisibilityStorage, ServerVisibilityStore } from "./server-visibility-core";
export {
  createServerVisibilityStore,
  decodeHiddenServerIds,
  filterVisibleServers,
  mergeVisibleServerOrder,
  serverMoveAccessibility,
  serverVisibilityStorageKey,
} from "./server-visibility-core";

const EMPTY_HIDDEN_SERVER_IDS = Object.freeze([]);

const visibilityStore = createServerVisibilityStore({
  getItem: (key) => SecureStore.getItem(key),
  setItem: (key, value) =>
    SecureStore.setItem(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
});

export function useServerVisibility(apiUrl: string, userId: string) {
  const key = serverVisibilityStorageKey(apiUrl, userId);
  const hiddenServerIds = useSyncExternalStore(
    (listener) => visibilityStore.subscribe(key, listener),
    () => visibilityStore.get(key),
    () => EMPTY_HIDDEN_SERVER_IDS,
  );
  const hideServer = useCallback((serverId: string) => visibilityStore.hide(key, serverId), [key]);
  const showServer = useCallback((serverId: string) => visibilityStore.show(key, serverId), [key]);
  const showAllServers = useCallback(() => visibilityStore.showAll(key), [key]);
  return { hiddenServerIds, hideServer, showServer, showAllServers };
}
