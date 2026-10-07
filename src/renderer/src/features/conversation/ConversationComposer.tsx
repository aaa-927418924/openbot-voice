import { supportedAttachmentExtensions } from "@openbot/contracts/attachment-files";
import { accountUsageCoversModel, canPreviewAttachment } from "@openbot/contracts/ipc";
import {
  TEAM_EML_ATTACHMENTS_CAPABILITY,
  TEAM_MEDIA_ATTACHMENTS_CAPABILITY,
} from "@openbot/contracts/team-protocol/current";
import { LIVE_VOICE_CAPABILITY } from "@openbot/contracts/team-protocol/live-voice-v1";
import {
  ArrowUp,
  Button,
  DropdownMenu,
  File,
  Image,
  ImageRemoveButton,
  Input,
  LoaderCircle,
  Mic,
  Plus,
  Puzzle,
} from "@openbot/ui";
import { fileBadge } from "@openbot/ui/features/conversation/AttachmentCards";
import { attachmentReferenceTone } from "@openbot/ui/features/conversation/AttachmentReference";
import { AwaitingReplies } from "@openbot/ui/features/conversation/AwaitingReplies";
import { ComposerEditor } from "@openbot/ui/features/conversation/ComposerEditor";
import { ComposerErrorBanner } from "@openbot/ui/features/conversation/ComposerErrorBanner";
import { ComposerSignInNotice, ComposerUsageLimitNotice } from "@openbot/ui/features/conversation/ComposerNotice";
import { CloseIcon, StopIcon } from "@openbot/ui/features/conversation/ConversationIcons";
import { RichMessageText } from "@openbot/ui/features/conversation/RichMessageText";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, Loading, lazy, onCleanup, Show } from "solid-js";
import { deviceSendShortcut, sendShortcutAriaKey, sendShortcutHintKey } from "../../send-shortcut-preference";
import { type LiveVoiceOrigin, useLiveVoice } from "../live-voice/live-voice-context";
import { serverSupportsCapability } from "../servers/server-capabilities";
import { useConversationViewScope } from "./conversation-scope";

/** @internal Stable HMR boundary for conversation composer. */
export function ConversationComposer() {
  const {
    agentReady,
    attachmentAction,
    attachmentBusy,
    awaitingReplies,
    dismissAwaitingReplies,
    composerFocusRequest,
    composerHasContent,
    currentChatConversationKey,
    currentChatError,
    currentDraft,
    dismissCurrentChatErrors,
    installedSkills,
    installedSkillsLoadFailed,
    mcpServers,
    editQueuedMessage,
    editingDeliveryId,
    editingPendingSave,
    openAttachmentPicker,
    openAttachmentPickerFromKey,
    openExternalMessageUrl,
    presentedQueueDeliveries,
    previewAttachment,
    props,
    queuePanelVisible,
    removeAttachment,
    reorderPresentedQueue,
    replyTarget,
    setComposerFocusRequest,
    setAttachmentPickerElement,
    setShowComposerActions,
    showComposerActions,
    submitComposer,
    submitting,
    unreferencedDraftAttachments,
    updateCurrentDraft,
    updateTeamTyping,
    voicePhase,
  } = useConversationViewScope();
  const { t, format } = useText();
  const messageLabel = () =>
    props.agent?.name
      ? t("composer.placeholder.message", { name: props.agent.name })
      : t("composer.placeholder.messageAgent");
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [skillPickerRequest, setSkillPickerRequest] = createSignal(0);
  let skillPickerChosen = false;
  // A pending Save keeps its exact request for retry. Block changes until retry or cancel.
  const savePending = () => Boolean(editingDeliveryId() && editingPendingSave());
  // The mention picker grows out of the same edge as the queue, so only one of them holds it.
  const queueVisible = () => queuePanelVisible() && !pickerOpen();
  const awaitingVisible = () => awaitingReplies().length > 0 && !pickerOpen();
  const slotOpen = () => queueVisible() || awaitingVisible();
  /**
   * The Live voice control now sits where the microphone button for dictation used to be. It shows on
   * the platform that can carry a session, when this window has a Live voice channel at all, and it
   * is live only when there is something to use: a codex agent with a thread, on the local host or on
   * a remote one that advertised the route. Outside that it stays where the user expects a microphone
   * and simply does nothing, which says more than a control that comes and goes.
   */
  const live = useLiveVoice();
  const liveAvailable = () => !props.runtime && props.platform === "win32" && live.available();
  const liveSession = () => live.state().hostSessionActive || live.state().phase === "connecting";
  const liveTarget = createMemo<LiveVoiceOrigin | undefined>(() => {
    const agent = props.agent;
    const server = props.server;
    if (!liveAvailable() || !server || agent?.provider !== "codex" || !agent.threadId) return undefined;
    const usable =
      server.kind === "local" ? server.id === "local" : serverSupportsCapability(server, LIVE_VOICE_CAPABILITY);
    if (!usable) return undefined;
    return {
      agentId: agent.id,
      threadId: agent.threadId,
      serverId: server.id,
      agent: {
        id: agent.id,
        name: agent.name,
        provider: agent.provider,
        avatarSeed: agent.avatarSeed,
        avatarHue: agent.avatarHue,
        avatarUrl: agent.avatarUrl,
      },
    };
  });
  const onLiveVoice = () => {
    if (liveSession()) {
      // The browser refusing to play is the one thing the button can fix on its own; otherwise the
      // press means what a microphone button always means - the conversation is over. The panel keeps
      // its own Stop for the case where a hand is already on it.
      if (live.state().audioBlocked) void live.resumeAudio();
      else void live.stop();
      return;
    }
    const target = liveTarget();
    if (target) void live.start(target);
  };
  /**
   * The Live voice dock hangs over the same bottom-right corner the composer occupies, and it lives at
   * the shell rather than here, so it cannot read this element's box. The composer publishes how much
   * of the window it takes as a root custom property, which is what keeps the panel off the send
   * arrow instead of a fixed corner guess that a taller draft would break.
   */
  let composerWrap: HTMLDivElement | undefined;
  createEffect(
    () => composerWrap,
    (element) => {
      if (!element) return;
      const publish = () => {
        const { top } = element.getBoundingClientRect();
        document.documentElement.style.setProperty(
          "--live-voice-dock-bottom",
          `${Math.max(0, Math.round(window.innerHeight - top))}px`,
        );
      };
      publish();
      window.addEventListener("resize", publish);
      const observer = typeof ResizeObserver === "function" ? new ResizeObserver(publish) : undefined;
      observer?.observe(element);
      onCleanup(() => {
        window.removeEventListener("resize", publish);
        observer?.disconnect();
        document.documentElement.style.removeProperty("--live-voice-dock-bottom");
      });
    },
  );
  /**
   * The provider status is the only source of truth for a signed-out provider, so the notice and the
   * model picker's "Sign in required" label can never disagree, and the notice is shown before the
   * user sends rather than only after a request comes back 401.
   */
  const signInRequired = createMemo(() => {
    const provider = props.agent?.provider;
    if (!provider || !props.onSignInProvider) return null;
    // OpenCode is signed in by pasting a key in settings, not by a login this button can start, so
    // its notice would carry a button that does nothing. Every other provider opens its own OAuth.
    if (provider === "opencode") return null;
    const status = props.agentStatus.providers?.find((item) => item.id === provider);
    return status?.state === "sign-in-required" ? status : null;
  });
  /**
   * A window that ended gives the quota back, and the reading that named it stays as it was until
   * something asks the provider again. So the clock is part of the state, not only the percentage.
   */
  const [now, setNow] = createSignal(Date.now());
  /**
   * The first plan window that is spent and has not ended yet. `usedPercent` is what the provider
   * reports, so it can pass 100 slightly; anything at or over the line refuses the next turn.
   */
  const usageExhausted = createMemo(() => {
    const provider = props.agent?.provider;
    if (!provider || signInRequired() || !accountUsageCoversModel(provider, props.agent?.model)) return null;
    for (const limit of props.accountUsage?.limits ?? []) {
      if (limit.id !== provider) continue;
      for (const plan of [limit.primary, limit.secondary]) {
        if (!plan || plan.usedPercent < 100) continue;
        if (plan.resetsAt !== null && plan.resetsAt * 1_000 <= now()) continue;
        return { provider, resetsAt: plan.resetsAt };
      }
    }
    return null;
  });
  // The card has to leave on its own. Nothing else reads usage again until the next turn, and the
  // user waiting for the reset is the one least likely to send one.
  createEffect(
    () => usageExhausted()?.resetsAt ?? null,
    (resetsAt) => {
      if (resetsAt === null) return;
      const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, resetsAt * 1_000 - Date.now()));
      onCleanup(() => window.clearTimeout(timer));
    },
  );
  const attachmentAccept = () => {
    const server = props.server;
    const local = server?.kind !== "remote";
    const capabilities = server?.compatibility?.capabilities ?? [];
    return supportedAttachmentExtensions({
      eml: local || capabilities.includes(TEAM_EML_ATTACHMENTS_CAPABILITY),
      media: local || capabilities.includes(TEAM_MEDIA_ATTACHMENTS_CAPABILITY),
    })
      .map((extension) => `.${extension}`)
      .join(",");
  };
  return (
    <Show when={!props.approval && !props.browserTakeover}>
      <div class="composer-wrap" ref={composerWrap}>
        <div
          class="agent-queue-slot"
          data-open={slotOpen() ? "true" : "false"}
          aria-hidden={slotOpen() ? undefined : "true"}
          inert={slotOpen() ? undefined : true}
        >
          <div class="agent-queue-slot-inner">
            <Show when={awaitingVisible()}>
              <AwaitingReplies items={awaitingReplies()} onDismiss={dismissAwaitingReplies} />
            </Show>
            <Show when={queueVisible()}>
              <Loading>
                <QueuePanel
                  deliveries={presentedQueueDeliveries()}
                  // Only for an agent that is waiting. When the channel work is this agent's own,
                  // the activity line above already shows it working, and naming it twice reads as
                  // two different waits.
                  hold={props.queue?.hold?.agentId === props.agent?.id ? null : props.queue?.hold}
                  agents={props.agents}
                  skills={installedSkills()}
                  editingDeliveryId={editingDeliveryId()}
                  canSteer={Boolean(props.activeTurnId)}
                  onSteer={props.onSteerQueuedMessage}
                  onCancel={props.onCancelQueuedMessage}
                  onEdit={editQueuedMessage}
                  onReorder={reorderPresentedQueue}
                />
              </Loading>
            </Show>
          </div>
        </div>
        <Show when={replyTarget()}>
          {(message) => (
            <div class="composer-reply-preview">
              <div>
                <span>{t(message().author === "you" ? "composer.reply.toYou" : "composer.reply.toAgent")}</span>
                <p>
                  <RichMessageText
                    body={message().body || t("composer.reply.attachment")}
                    agents={props.agents}
                    skills={installedSkills()}
                    attachments={message().attachments}
                    onSelectAgent={props.onSelectAgent}
                    onOpenLink={(url) => void openExternalMessageUrl(url)}
                    onOpenAttachment={(attachment) => void previewAttachment(attachment)}
                  />
                </p>
              </div>
              <Button
                variant="ghost"
                type="button"
                aria-label={t("composer.reply.cancel")}
                disabled={voicePhase() === "transcribing"}
                onClick={() => updateCurrentDraft({ replyToMessageId: null })}
              >
                <CloseIcon />
              </Button>
            </div>
          )}
        </Show>
        <Show when={signInRequired()}>
          {(status) => (
            <ComposerSignInNotice
              provider={status().id}
              signingIn={status().connectionState === "connecting"}
              onSignIn={(provider) => props.onSignInProvider?.(provider)}
            />
          )}
        </Show>
        <Show when={usageExhausted()}>
          {(spent) => <ComposerUsageLimitNotice provider={spent().provider} resetsAt={spent().resetsAt} />}
        </Show>
        <Show when={currentChatError()}>
          {(message) => (
            <ComposerErrorBanner
              message={message()}
              conversationKey={currentChatConversationKey()}
              onDismiss={() => {
                dismissCurrentChatErrors();
                setComposerFocusRequest((current) => current + 1);
              }}
            />
          )}
        </Show>
        <div
          class={`composer${voicePhase() === "recording" ? " composer-recording" : ""}`}
          data-compact={
            currentDraft().text.includes("\n") || unreferencedDraftAttachments().length > 0 ? undefined : ""
          }
          data-has-attachments={unreferencedDraftAttachments().length > 0 ? "" : undefined}
          onPointerDown={(event) => {
            if (!(event.target instanceof Element)) return;
            if (event.target.closest("button, .composer-editor-surface")) return;
            event.preventDefault();
            setComposerFocusRequest((current) => current + 1);
          }}
        >
          <Show when={unreferencedDraftAttachments().length > 0}>
            <div class="composer-attachments">
              <For each={unreferencedDraftAttachments()}>
                {(attachment) => {
                  // An image with no preview (the web client) shows as a file, with its name.
                  const chip = () => (attachment.kind === "image" && attachment.previewUrl ? "image" : "file");
                  return (
                    <div class="composer-attachment ui-removable-image" data-kind={chip()}>
                      <span
                        class="composer-attachment-preview"
                        data-file-tone={chip() === "file" ? attachmentReferenceTone(attachment.name) : undefined}
                      >
                        <Show when={chip() === "image"} fallback={fileBadge(attachment)}>
                          <img src={attachment.previewUrl ?? ""} alt="" />
                        </Show>
                      </span>
                      <Show when={chip() === "file"}>
                        <span class="composer-attachment-copy">
                          <strong title={attachment.name}>{attachment.name}</strong>
                          <small>{format.fileSize(attachment.size)}</small>
                        </span>
                      </Show>
                      <ImageRemoveButton
                        label={t("composer.attachment.remove", { name: attachment.name })}
                        disabled={voicePhase() === "transcribing" || savePending()}
                        onClick={() => removeAttachment(attachment.id)}
                      />
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
          <div class="composer-input-label">
            <ComposerEditor
              agentId={props.agent?.id}
              agents={props.agents}
              skills={installedSkills()}
              skillsLoadFailed={installedSkillsLoadFailed()}
              mcpServers={mcpServers()}
              attachments={currentDraft().attachments}
              value={currentDraft().text}
              disabled={submitting() || voicePhase() === "transcribing" || !agentReady() || savePending()}
              placeholder={
                !agentReady()
                  ? props.runtime
                    ? props.server?.state === "online"
                      ? t("composer.placeholder.hostSetup")
                      : props.server?.hostedSleep === "sleeping"
                        ? t("composer.placeholder.hostSleeping")
                        : props.server?.hostedSleep === "waking"
                          ? t("composer.placeholder.hostWaking")
                          : t("composer.placeholder.connectHost")
                    : t("composer.placeholder.cliSetup")
                  : replyTarget()
                    ? t("composer.placeholder.reply")
                    : messageLabel()
              }
              ariaLabel={messageLabel()}
              focusRequest={composerFocusRequest()}
              skillPickerRequest={skillPickerRequest()}
              onValueChange={(text) => {
                updateCurrentDraft({ text });
                updateTeamTyping(text);
              }}
              onSubmit={submitComposer}
              sendShortcut={deviceSendShortcut(props.platform)}
              onPickerOpenChange={setPickerOpen}
              onPasteFiles={(files) => {
                if (props.runtime?.importFiles) void props.runtime.importFiles(files);
              }}
              onOpenAttachment={(attachment) =>
                canPreviewAttachment(attachment)
                  ? void previewAttachment(attachment)
                  : attachmentAction(attachment, "open")
              }
            />
          </div>
          <div class="composer-toolbar">
            <Input
              ref={setAttachmentPickerElement}
              type="file"
              accept={attachmentAccept()}
              multiple
              hidden
              tabindex={-1}
              data-openbot-attachment-picker={props.runtime ? undefined : "true"}
              onChange={(event) => {
                if (props.runtime?.importFiles)
                  void props.runtime.importFiles(Array.from(event.currentTarget.files ?? []));
              }}
            />
            <DropdownMenu.Root
              open={showComposerActions()}
              onOpenChange={(open) => {
                setShowComposerActions(open);
                const chosen = skillPickerChosen;
                skillPickerChosen = false;
                if (open || !chosen) return;
                // The menu gives the focus back to its trigger two frames after it closes; open the picker after that.
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => setSkillPickerRequest((current) => current + 1)),
                  ),
                );
              }}
              placement="top-start"
              gutter={8}
              modal={false}
            >
              <DropdownMenu.Trigger
                class="composer-button"
                aria-label={t("composer.add.label")}
                disabled={
                  attachmentBusy() || submitting() || voicePhase() === "transcribing" || !agentReady() || savePending()
                }
              >
                <Plus aria-hidden="true" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content aria-label={t("composer.add.label")}>
                  <DropdownMenu.Item
                    disabled={attachmentBusy()}
                    onPointerDown={(event) => {
                      if (event.button === 0) openAttachmentPicker();
                    }}
                    onKeyDown={(event) => openAttachmentPickerFromKey(event)}
                  >
                    <Image aria-hidden="true" />
                    <span>{t("composer.add.image")}</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onPointerDown={(event) => {
                      if (event.button === 0) skillPickerChosen = true;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") skillPickerChosen = true;
                    }}
                  >
                    <Puzzle aria-hidden="true" />
                    <span>{t("composer.add.skill")}</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={attachmentBusy()}
                    onPointerDown={(event) => {
                      if (event.button === 0) openAttachmentPicker();
                    }}
                    onKeyDown={(event) => openAttachmentPickerFromKey(event)}
                  >
                    <File aria-hidden="true" />
                    <span>{t("composer.add.context")}</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <div class="composer-primary-actions">
              <Show when={attachmentBusy() && props.runtime?.cancelImportFiles} keyed>
                {(cancelImportFiles) => (
                  <Button variant="ghost" type="button" onClick={() => void cancelImportFiles()}>
                    {t("composer.upload.cancel")}
                  </Button>
                )}
              </Show>
              <Show when={liveAvailable()}>
                <Button
                  variant="ghost"
                  type="button"
                  class="dictation-button"
                  aria-label={liveSession() ? t("composer.liveVoice.stop") : t("composer.liveVoice.start")}
                  aria-pressed={liveSession() ? "true" : "false"}
                  disabled={!liveSession() && !liveTarget()}
                  onClick={onLiveVoice}
                >
                  <Mic aria-hidden="true" />
                </Button>
              </Show>
              <Show
                when={
                  props.activeTurnId && !editingDeliveryId() && !composerHasContent() && voicePhase() !== "recording"
                }
                fallback={
                  <Button
                    variant="ghost"
                    type="button"
                    class="voice-button"
                    aria-label={
                      editingDeliveryId()
                        ? t("composer.send.saveQueued")
                        : voicePhase() === "recording"
                          ? t("composer.send.voice")
                          : t("composer.send.message")
                    }
                    aria-keyshortcuts={
                      voicePhase() === "recording" ? undefined : sendShortcutAriaKey(deviceSendShortcut(props.platform))
                    }
                    title={
                      voicePhase() === "recording"
                        ? undefined
                        : t(
                            sendShortcutHintKey(
                              deviceSendShortcut(props.platform),
                              editingDeliveryId() ? "save" : "send",
                            ),
                          )
                    }
                    data-cuelume-emphasis="normal"
                    disabled={
                      attachmentBusy() ||
                      submitting() ||
                      !agentReady() ||
                      voicePhase() === "preparing" ||
                      voicePhase() === "requesting" ||
                      voicePhase() === "transcribing"
                    }
                    onClick={submitComposer}
                  >
                    <Show when={submitting()} fallback={<ArrowUp aria-hidden="true" />}>
                      <LoaderCircle class="composer-spinner" aria-hidden="true" />
                    </Show>
                  </Button>
                }
              >
                <Button
                  variant="ghost"
                  type="button"
                  class="voice-button voice-button-active"
                  aria-label={t("composer.send.stop")}
                  data-cuelume-tap="close"
                  onClick={props.onStop}
                >
                  <StopIcon />
                </Button>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

const QueuePanel = lazy(() =>
  import("@openbot/ui/features/conversation/QueuePanel").then((module) => ({ default: module.QueuePanel })),
);
