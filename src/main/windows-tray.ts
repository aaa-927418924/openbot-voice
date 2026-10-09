import type { AppTranslate } from "@openbot/i18n";
import { type BrowserWindow, Menu, type NativeImage, Tray } from "electron";

export interface WindowsTrayController {
  setIcon: (icon: NativeImage) => void;
  setTranslate: (translate: AppTranslate) => void;
  destroy: () => void;
}

export interface WindowsTrayOptions {
  platform: NodeJS.Platform;
  icon: NativeImage;
  getTranslate: () => AppTranslate;
  getMainWindow: () => BrowserWindow | null;
  ensureMainWindow: () => Promise<BrowserWindow>;
  showMainWindow: (window: BrowserWindow) => void;
  quit: () => void;
  reportError: (message: string, error: unknown) => void;
}

export function createWindowsTray(options: WindowsTrayOptions): WindowsTrayController | null {
  if (options.platform !== "win32") return null;
  const tray = new Tray(options.icon);
  tray.setToolTip("OpenBot");

  function showWindow(): void {
    const window = options.getMainWindow();
    if (window && !window.isDestroyed()) {
      options.showMainWindow(window);
      return;
    }
    void options
      .ensureMainWindow()
      .then(options.showMainWindow)
      .catch((error) => {
        options.reportError("Unable to reopen the main window from the tray:", error);
      });
  }

  function setTranslate(translate: AppTranslate): void {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: translate("window.tray.open"), click: showWindow },
        { type: "separator" },
        { label: translate("window.tray.quit"), click: options.quit },
      ]),
    );
  }

  tray.on("click", showWindow);
  setTranslate(options.getTranslate());
  return {
    setIcon: (icon) => tray.setImage(icon),
    setTranslate,
    destroy: () => tray.destroy(),
  };
}
