import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";

const RELOAD_DEBOUNCE_MS = 200;

/** Watches one admin instruction file without keeping the Electron process alive. */
export function watchGlobalAgentInstructions(
  path: string,
  onChange: () => void,
  onError: (error: unknown) => void,
): () => void {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher;

  try {
    watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename !== null && filename.toString() !== basename(path)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (!closed) onChange();
      }, RELOAD_DEBOUNCE_MS);
    });
  } catch (error) {
    onError(error);
    return () => undefined;
  }

  watcher.on("error", onError);
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
