import type { ServerSummary } from "@openbot/contracts/ipc";
import { RemoteCompatibilityScreen } from "@openbot/ui/features/remote-desktop/RemoteCompatibilityScreen";
import type { JSX } from "@solidjs/web";
import { createEffect, omit, onCleanup, type ParentProps, Show } from "solid-js";
import type { DesktopThemeSettings } from "./features/settings/theme-settings";
import { useLayout } from "./layout";
import { LEFT_PANEL_COMPACT } from "./layout-constants";
import { usePlatform } from "./platform";
import { WorkspaceLeftPanelResizer } from "./WorkspaceLeftPanelResizer";

type WorkspaceFrameProps = ParentProps<
  {
    /** Whether the sidebar is drawn compact. The web keeps it wide on a phone, where it is a full pane. */
    compact: boolean;
    /** Set while the remote-desktop workspace covers the frame. */
    hidden?: boolean;
    /** A remote server this build cannot talk to. Its screen replaces the middle panes. */
    blockedServer: ServerSummary | null;
    onRetryServer: (serverId: string) => Promise<void>;
    /** The rail, the sidebar and the account dock, in paint order. */
    left: JSX.Element;
    /** Whether the usage report is open. While it is, the middle panes are inert. */
    usageOpen: boolean;
    /** The desktop's per-device background preference. The web frame leaves this unset. */
    theme?: DesktopThemeSettings;
    usage?: JSX.Element;
    /** Dialogs and overlays after the panes. */
    after?: JSX.Element;
  } & Omit<JSX.HTMLAttributes<HTMLDivElement>, "children">
>;

function workspaceThemeStyle(theme: DesktopThemeSettings | null): string {
  if (theme === null) return "";
  const { imageDataUrl, blur, opacity, accentColor } = theme;
  return `--workspace-theme-image: url("${imageDataUrl}"); --workspace-theme-blur: ${blur}px; --workspace-theme-opacity: ${opacity / 100}; --workspace-theme-accent: ${accentColor}`;
}

function titleBarOverlayTheme(): { color: string; symbolColor: string } | null {
  const headerColor = getComputedStyle(document.body, "::before").backgroundColor;
  const canvasColor = getComputedStyle(document.body).backgroundColor;
  const textColor = getComputedStyle(document.body).color;
  const sample = (color: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    return { red: data[0] ?? 0, green: data[1] ?? 0, blue: data[2] ?? 0, alpha: data[3] ?? 0 };
  };
  const header = sample(headerColor);
  const canvas = sample(canvasColor);
  const text = sample(textColor);
  if (!header || !canvas || !text) return null;

  const alpha = header.alpha / 255;
  const red = Math.round(header.red * alpha + canvas.red * (1 - alpha));
  const green = Math.round(header.green * alpha + canvas.green * (1 - alpha));
  const blue = Math.round(header.blue * alpha + canvas.blue * (1 - alpha));
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color: { red: number; green: number; blue: number }) =>
    0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue);
  const backgroundLuminance = luminance({ red, green, blue });
  const contrast = (foreground: number) =>
    (Math.max(backgroundLuminance, foreground) + 0.05) / (Math.min(backgroundLuminance, foreground) + 0.05);
  const textContrast = contrast(luminance(text));
  const canvasContrast = contrast(luminance(canvas));
  const symbol = textContrast >= canvasContrast ? text : canvas;

  return {
    color: `rgba(${header.red}, ${header.green}, ${header.blue}, ${alpha.toFixed(3)})`,
    symbolColor: `rgba(${symbol.red}, ${symbol.green}, ${symbol.blue}, ${(symbol.alpha / 255).toFixed(3)})`,
  };
}

/**
 * The application frame that the desktop shell and the web client share: the grid classes, the left
 * column width and its resizer, the compatibility screen, and the usage report slot. The panes come
 * from the caller, because the desktop reads them from its contexts and the web passes props.
 *
 * The order of the children is the paint order the stylesheet expects.
 */
export function WorkspaceFrame(props: WorkspaceFrameProps) {
  const platform = usePlatform();
  const layout = useLayout();
  const rest = omit(
    props,
    "compact",
    "hidden",
    "blockedServer",
    "onRetryServer",
    "left",
    "usageOpen",
    "theme",
    "usage",
    "after",
    "children",
    "class",
  );
  const customTheme = () => (props.theme?.mode === "custom" && props.theme.imageDataUrl ? props.theme : null);

  createEffect(
    () => customTheme(),
    (theme) => {
      const body = document.body;
      body.classList.toggle("app-custom-theme", theme !== null);
      if (theme) {
        body.style.setProperty("--workspace-theme-image", `url("${theme.imageDataUrl}")`);
        body.style.setProperty("--workspace-theme-blur", `${theme.blur}px`);
        body.style.setProperty("--workspace-theme-opacity", String(theme.opacity / 100));
        body.style.setProperty("--workspace-theme-accent", theme.accentColor);
      } else {
        body.style.removeProperty("--workspace-theme-image");
        body.style.removeProperty("--workspace-theme-blur");
        body.style.removeProperty("--workspace-theme-opacity");
        body.style.removeProperty("--workspace-theme-accent");
      }
      const appInfo = platform.appInfo();
      if (appInfo?.platform === "linux") {
        const overlay = titleBarOverlayTheme();
        if (overlay) void window.openbot.setTitleBarOverlayTheme(overlay).catch(() => undefined);
      }
    },
  );

  onCleanup(() => {
    document.body.classList.remove("app-custom-theme");
    document.body.style.removeProperty("--workspace-theme-image");
    document.body.style.removeProperty("--workspace-theme-blur");
    document.body.style.removeProperty("--workspace-theme-opacity");
    document.body.style.removeProperty("--workspace-theme-accent");
    const appInfo = platform.appInfo();
    if (appInfo?.platform === "linux") {
      const overlay = titleBarOverlayTheme();
      if (overlay) void window.openbot.setTitleBarOverlayTheme(overlay).catch(() => undefined);
    }
  });

  return (
    <div
      {...rest}
      ref={platform.setAppFrameElement}
      class={[
        "app-frame",
        props.class,
        {
          "app-frame-sidebar-compact": props.compact,
          "app-frame-edge": platform.appInfo() !== null,
          "app-frame-with-server-rail": layout.serverRailVisible(),
          "app-frame-usage-open": props.usageOpen,
          "app-frame-platform-darwin": platform.appInfo()?.platform === "darwin",
          "app-frame-custom-theme": customTheme() !== null,
        },
      ]}
      aria-hidden={props.hidden ? "true" : undefined}
      style={`--left-panel-width: ${props.compact ? LEFT_PANEL_COMPACT : layout.leftPanelWidth()}px; ${workspaceThemeStyle(customTheme())}`}
    >
      {props.left}
      <WorkspaceLeftPanelResizer />
      <div class="usage-workspace-content" inert={props.usageOpen} aria-hidden={props.usageOpen ? "true" : undefined}>
        <Show when={props.blockedServer} keyed fallback={props.children}>
          {(server) => <RemoteCompatibilityScreen server={server} onRetry={() => props.onRetryServer(server.id)} />}
        </Show>
      </div>
      <Show when={props.usageOpen}>
        <div class="conversation-panel agent-usage-workspace">{props.usage}</div>
      </Show>
      {props.after}
    </div>
  );
}
