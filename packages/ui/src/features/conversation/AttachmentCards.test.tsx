import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { render, screen, waitFor } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@openbot/ui", () => {
  const Button = (props: {
    children?: JSX.Element;
    type?: "button" | "submit" | "reset";
    class?: string;
    "aria-label"?: string;
    title?: string;
    onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  }) => (
    <button
      type={props.type}
      class={props.class}
      aria-label={props["aria-label"]}
      title={props.title}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
  const Dialog = {
    Root: (props: { open: boolean; children?: JSX.Element }) => (props.open ? <div>{props.children}</div> : null),
    Portal: (props: { children?: JSX.Element }) => <>{props.children}</>,
    Overlay: (props: { class?: string; children?: JSX.Element }) => <div class={props.class}>{props.children}</div>,
    Content: (props: { class?: string; children?: JSX.Element }) => (
      <section role="dialog" class={props.class}>
        {props.children}
      </section>
    ),
    Title: (props: { class?: string; children?: JSX.Element }) => <h2 class={props.class}>{props.children}</h2>,
  };
  return { Button, Dialog, Download: () => null, Spinner: () => null, X: () => null };
});
vi.mock("../../text", () => ({
  useText: () => ({
    t: (key: string, args?: { name?: string }) => (args?.name ? `${key}:${args.name}` : key),
    format: { fileSize: () => "1 MB" },
  }),
}));
vi.mock("./AnchoredTooltip", () => ({ AnchoredTooltip: () => null }));

import { AttachmentCards } from "./AttachmentCards";

const attachment: AttachmentSummary = {
  id: "video-1",
  name: "clip.mp4",
  kind: "file",
  mimeType: "video/mp4",
  size: 1024,
  previewKind: "none",
  previewUrl: "blob:clip",
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("uses the native video expand control to open the in-app preview", async () => {
  const fullscreenElement = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
  const exitFullscreen = Object.getOwnPropertyDescriptor(document, "exitFullscreen");
  const { container } = render(() => (
    <AttachmentCards attachments={[attachment]} onPreview={vi.fn()} onAction={vi.fn()} />
  ));
  const video = container.querySelector("video");
  expect(video).not.toBeNull();
  if (!video) throw new Error("Inline MP4 preview was not rendered.");

  const pause = vi.fn();
  Object.defineProperty(video, "paused", { configurable: true, value: false });
  Object.defineProperty(video, "currentTime", { configurable: true, value: 12 });
  video.pause = pause;
  const exit = vi.fn(async () => {
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: video });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exit });
  document.dispatchEvent(new Event("fullscreenchange"));

  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  expect(video).toHaveAttribute("controls");
  expect(video).not.toHaveAttribute("controlslist");
  expect(exit).toHaveBeenCalledOnce();
  expect(pause).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "chat.preview.expandLabel" })).toBeNull();
  expect(screen.getByRole("heading", { name: "clip.mp4" })).toBeTruthy();
  expect(screen.getAllByLabelText("attachment.preview:clip.mp4")).toHaveLength(2);

  if (fullscreenElement) Object.defineProperty(document, "fullscreenElement", fullscreenElement);
  else Reflect.deleteProperty(document, "fullscreenElement");
  if (exitFullscreen) Object.defineProperty(document, "exitFullscreen", exitFullscreen);
  else Reflect.deleteProperty(document, "exitFullscreen");
});
