import { Button, Maximize2, Minimize2, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { Portal } from "@solidjs/web";
import { createEffect, onCleanup, Show } from "solid-js";
import { usePlatform } from "./platform";

type MainWindowControlAction = "minimize" | "toggle-maximize" | "close";

export function WindowControls() {
  const platform = usePlatform();
  const { t } = useText();
  const isWindows = () => platform.appInfo()?.platform === "win32";

  createEffect(
    () => isWindows(),
    (windows) => {
      document.body.classList.toggle("app-window-controls", windows);
    },
  );
  onCleanup(() => document.body.classList.remove("app-window-controls"));

  const control = (action: MainWindowControlAction) => {
    void window.openbot.controlMainWindow(action).catch(() => undefined);
  };

  return (
    <Show when={isWindows()}>
      <Portal>
        <div class="native-window-controls">
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            class="native-window-control"
            aria-label={t("window.controls.minimize")}
            title={t("window.controls.minimize")}
            onClick={() => control("minimize")}
          >
            <Minimize2 aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            class="native-window-control"
            aria-label={t("window.controls.maximizeRestore")}
            title={t("window.controls.maximizeRestore")}
            onClick={() => control("toggle-maximize")}
          >
            <Maximize2 aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            class="native-window-control native-window-controls-close"
            aria-label={t("window.controls.close")}
            title={t("window.controls.close")}
            onClick={() => control("close")}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </Portal>
    </Show>
  );
}
