import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@openbot/ui", async (importOriginal) => {
  const ui = await importOriginal<typeof import("@openbot/ui")>();
  return { ...ui, Download: () => null, Maximize2: () => null, Spinner: () => null, X: () => null };
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

it("expands a video inside the app window without entering monitor fullscreen", async () => {
  const { container } = render(() => (
    <AttachmentCards attachments={[attachment]} onPreview={vi.fn()} onAction={vi.fn()} />
  ));
  const inlineVideo = container.querySelector("video");
  expect(inlineVideo).not.toBeNull();
  if (!inlineVideo) throw new Error("Inline MP4 preview was not rendered.");

  const pause = vi.fn();
  Object.defineProperty(inlineVideo, "paused", { configurable: true, value: false });
  Object.defineProperty(inlineVideo, "currentTime", { configurable: true, value: 12 });
  inlineVideo.pause = pause;

  await fireEvent.click(screen.getByRole("button", { name: "chat.preview.expandLabel" }));

  expect(inlineVideo).toHaveAttribute("controls");
  expect(inlineVideo).toHaveAttribute("controlslist", "nofullscreen");
  expect(pause).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "clip.mp4" })).toBeTruthy();
  const previews = screen.getAllByLabelText("attachment.preview:clip.mp4");
  expect(previews).toHaveLength(2);
  expect(previews[1]).toHaveAttribute("controlslist", "nofullscreen");
});
