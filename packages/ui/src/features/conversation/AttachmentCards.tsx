import { playableMediaKind } from "@openbot/contracts/attachment-files";
import { type AttachmentSummary, canPreviewAttachment } from "@openbot/contracts/ipc";
import { Button, Dialog, Download, Spinner, X } from "@openbot/ui";
import { createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { useText } from "../../text";
import { AnchoredTooltip } from "./AnchoredTooltip";
import { attachmentReferenceTone } from "./AttachmentReference";

/**
 * The whole-list action, shaped like the account update island: a tinted bar
 * that states what is attached, with a light action button beside it. The
 * bottom edge tucks under the first attachment card, so the stack reads as one
 * object rather than a button parked above a list.
 */
export function AttachmentDownloadAll(props: { count: number; pending: boolean; onDownload: () => void }) {
  const { t } = useText();
  const label = () => (props.pending ? t("attachment.downloadAll.pending") : t("attachment.downloadAll.label"));
  return (
    <div class="attachment-download-island">
      <p class="attachment-download-island__copy">{t("attachment.downloadAll.count", { count: props.count })}</p>
      <div class="attachment-download-island__action-shell">
        <Button
          type="button"
          size="xs"
          class="attachment-download-island__action"
          aria-label={label()}
          aria-busy={props.pending ? "true" : undefined}
          disabled={props.pending}
          onClick={() => props.onDownload()}
        >
          <span class="attachment-download-island__action-content">
            <span class="attachment-download-island__icon t-icon-swap" data-state={props.pending ? "b" : "a"}>
              <span class="t-icon" data-icon="a" aria-hidden="true">
                <Download />
              </span>
              <span class="t-icon" data-icon="b" aria-hidden="true">
                <Spinner size="sm" />
              </span>
            </span>
            <span
              class="attachment-download-island__action-label"
              data-state={props.pending ? "pending" : "action"}
              aria-hidden="true"
            >
              <span data-text="action">{t("common.download")}</span>
              <span data-text="pending">{t("attachment.downloadAll.zipping")}</span>
            </span>
          </span>
        </Button>
      </div>
    </div>
  );
}

export function AttachmentCards(props: {
  attachments: AttachmentSummary[];
  /** `origin` is the clicked card, for a viewer that zooms out of it. */
  onPreview: (attachment: AttachmentSummary, origin: HTMLElement) => void;
  onAction: (attachment: AttachmentSummary, action: "open" | "reveal" | "download") => void;
}) {
  const { t, format } = useText();
  const tooltipId = `attachment-action-tooltip-${createUniqueId()}`;
  const [tooltip, setTooltip] = createSignal<{ anchor: HTMLElement; content: string } | null>(null);
  // An image whose preview does not load was deleted from the host, or never arrived. The card
  // keeps its place in the message and says so, instead of an empty frame.
  const [missing, setMissing] = createSignal<ReadonlySet<string>>(new Set());
  const [expandedVideo, setExpandedVideo] = createSignal<{
    attachment: AttachmentSummary;
    currentTime: number;
    wasPlaying: boolean;
  } | null>(null);
  const videoElements = new Map<string, HTMLVideoElement>();
  const isMissing = (attachment: AttachmentSummary) => missing().has(attachment.id);
  const markMissing = (attachment: AttachmentSummary) => setMissing((current) => new Set(current).add(attachment.id));

  const openTooltip = (anchor: HTMLElement) => {
    setTooltip({ anchor, content: t("attachment.openFile") });
  };
  const closeTooltip = (anchor: HTMLElement) => {
    if (tooltip()?.anchor === anchor) setTooltip(null);
  };
  const closeTooltipOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && event.currentTarget instanceof HTMLElement) closeTooltip(event.currentTarget);
  };

  return (
    <>
      <div class="message-attachments">
        <For each={props.attachments}>
          {(attachment) => {
            let inlineVideo: HTMLVideoElement | undefined;
            const handleNativeExpand = () => {
              if (!inlineVideo || document.fullscreenElement !== inlineVideo) return;
              const wasPlaying = !inlineVideo.paused;
              const currentTime = inlineVideo.currentTime;
              inlineVideo.pause();
              const state = { attachment, currentTime, wasPlaying };
              void document
                .exitFullscreen()
                .catch(() => undefined)
                .then(() => setExpandedVideo(state));
            };
            document.addEventListener("fullscreenchange", handleNativeExpand);
            onCleanup(() => {
              document.removeEventListener("fullscreenchange", handleNativeExpand);
              if (videoElements.get(attachment.id) === inlineVideo) videoElements.delete(attachment.id);
            });
            return (
              <div
                class="message-attachment"
                data-kind={playableMediaKind(attachment.mimeType) === "video" ? "video" : undefined}
                data-status={isMissing(attachment) ? "missing" : undefined}
              >
                <Show
                  when={playableMediaKind(attachment.mimeType) === "video"}
                  fallback={
                    <Button
                      variant="ghost"
                      type="button"
                      class="attachment-preview-button"
                      disabled={isMissing(attachment) || !canPreviewAttachment(attachment)}
                      aria-label={t("attachment.preview", { name: attachment.name })}
                      data-attachment-id={attachment.id}
                      data-cuelume-tap="open"
                      onClick={(event) => props.onPreview(attachment, event.currentTarget)}
                    >
                      <Show
                        when={attachment.previewKind === "image" && attachment.previewUrl && !isMissing(attachment)}
                        fallback={
                          <span
                            class="attachment-file-visual"
                            data-file-tone={attachmentReferenceTone(attachment.name)}
                            aria-hidden="true"
                          >
                            <AttachmentFileIcon />
                          </span>
                        }
                      >
                        <span
                          class="attachment-file-visual attachment-file-image"
                          data-file-tone={attachmentReferenceTone(attachment.name)}
                        >
                          <img
                            src={attachment.previewUrl ?? ""}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            onError={() => markMissing(attachment)}
                          />
                        </span>
                      </Show>
                      <span class="attachment-file-copy">
                        <strong>{attachment.name}</strong>
                        <small>
                          {isMissing(attachment) ? t("attachment.notFound") : format.fileSize(attachment.size)}
                        </small>
                      </span>
                    </Button>
                  }
                >
                  <Show
                    when={attachment.previewUrl}
                    fallback={
                      <div class="attachment-video-metadata">
                        <strong>{attachment.name}</strong>
                        <small>{format.fileSize(attachment.size)}</small>
                      </div>
                    }
                  >
                    <div class="message-video-player">
                      <video
                        ref={(element) => {
                          inlineVideo = element;
                          videoElements.set(attachment.id, element);
                        }}
                        class="message-video-preview"
                        aria-label={t("attachment.preview", { name: attachment.name })}
                        controls
                        playsinline
                        preload="metadata"
                        src={attachment.previewUrl ?? ""}
                      >
                        <track kind="captions" />
                      </video>
                    </div>
                    <div class="attachment-video-metadata">
                      <span class="attachment-video-copy">
                        <strong>{attachment.name}</strong>
                        <small>{format.fileSize(attachment.size)}</small>
                      </span>
                    </div>
                  </Show>
                </Show>
                <Show when={!isMissing(attachment)}>
                  <Button
                    variant="ghost"
                    type="button"
                    class="attachment-open-button"
                    aria-label={t("attachment.download", { name: attachment.name })}
                    onClick={() => {
                      setTooltip(null);
                      props.onAction(attachment, "download");
                    }}
                  >
                    <Download />
                  </Button>
                  <Show when={playableMediaKind(attachment.mimeType) !== "video"}>
                    <Button
                      variant="ghost"
                      type="button"
                      class="attachment-open-button"
                      aria-label={t("attachment.open", { name: attachment.name })}
                      aria-describedby={tooltipId}
                      onPointerEnter={(event) => openTooltip(event.currentTarget)}
                      onMouseEnter={(event) => openTooltip(event.currentTarget)}
                      onPointerLeave={(event) => closeTooltip(event.currentTarget)}
                      onMouseLeave={(event) => closeTooltip(event.currentTarget)}
                      onFocus={(event) => openTooltip(event.currentTarget)}
                      onBlur={(event) => closeTooltip(event.currentTarget)}
                      onKeyDown={closeTooltipOnEscape}
                      onClick={() => {
                        setTooltip(null);
                        props.onAction(attachment, "open");
                      }}
                    >
                      <AttachmentOpenIcon />
                    </Button>
                  </Show>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={expandedVideo()}>
        {(current) => (
          <ExpandedVideoPreview
            attachment={current().attachment}
            currentTime={current().currentTime}
            wasPlaying={current().wasPlaying}
            onClose={(currentTime, shouldResume) => {
              const attachment = current().attachment;
              setExpandedVideo(null);
              const inline = videoElements.get(attachment.id);
              if (!inline) return;
              inline.currentTime = currentTime;
              if (shouldResume) void inline.play().catch(() => undefined);
            }}
          />
        )}
      </Show>
      <Show when={tooltip()}>
        {(current) => <AnchoredTooltip id={tooltipId} anchor={current().anchor} content={current().content} />}
      </Show>
    </>
  );
}

function ExpandedVideoPreview(props: {
  attachment: AttachmentSummary;
  currentTime: number;
  wasPlaying: boolean;
  onClose: (currentTime: number, shouldResume: boolean) => void;
}) {
  const { t } = useText();
  let video: HTMLVideoElement | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    props.onClose(video?.currentTime ?? props.currentTime, video ? !video.paused : props.wasPlaying);
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay class="message-preview-backdrop">
          <Dialog.Content class="message-video-preview-dialog" as="section">
            <header class="message-preview-dialog-header">
              <Dialog.Title class="message-preview-dialog-title">{props.attachment.name}</Dialog.Title>
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={t("common.close")}
                title={t("common.close")}
                onClick={close}
              >
                <X aria-hidden="true" />
              </Button>
            </header>
            <div class="message-video-preview-dialog-body">
              <video
                ref={(element) => (video = element)}
                class="message-video-preview-expanded"
                aria-label={t("attachment.preview", { name: props.attachment.name })}
                controls
                controlslist="nofullscreen"
                playsinline
                preload="metadata"
                src={props.attachment.previewUrl ?? ""}
                onLoadedMetadata={(event) => {
                  const element = event.currentTarget;
                  if (props.currentTime > 0 && props.currentTime < element.duration) {
                    element.currentTime = props.currentTime;
                  }
                  if (props.wasPlaying) void element.play().catch(() => undefined);
                }}
              >
                <track kind="captions" />
              </video>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function fileBadge(attachment: AttachmentSummary): string {
  if (attachment.previewKind === "pdf") return "PDF";
  if (attachment.previewKind === "text") return "TXT";
  return attachment.name.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE";
}

function AttachmentFileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M5.5 2.75h5.75l3.25 3.5v11H5.5z" />
      <path d="M11.25 2.75v3.5h3.25M7.75 10h4.5M7.75 13h4.5" />
    </svg>
  );
}

function AttachmentOpenIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M8.25 5.25H5.5v9.25h9.25v-2.75" />
      <path d="M10.25 5.25h4.5v4.5M14.5 5.5l-6 6" />
    </svg>
  );
}
