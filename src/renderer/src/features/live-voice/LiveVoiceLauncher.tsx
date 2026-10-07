import { Button, Mic, MicOff } from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { useText } from "@openbot/ui/text";
import { createMemo, For, Show } from "solid-js";
import { usePlatform } from "../../platform";
import { useLiveVoice } from "./live-voice-context";
import "./live-voice.css";

/**
 * The app-global Live voice panel; the provider and media owner outlive server-scoped pages, so this
 * stays above them. Starting a session belongs to the composer, where the microphone button always
 * was, and all that is left here is the panel itself.
 */
export function LiveVoiceLauncher() {
  const { t, errorMessage } = useText();
  const live = useLiveVoice();
  const platform = usePlatform();
  const active = () => live.state().hostSessionActive || live.state().phase === "connecting";
  const setStatus = createMemo(() => {
    const state = live.state();
    if (state.audioBlocked) return t("composer.liveVoice.audioBlocked");
    if (state.phase === "live") return t("composer.liveVoice.active");
    if (state.phase === "stopping") return t("composer.liveVoice.stopping");
    if (state.phase === "error")
      return state.microphoneBlocked
        ? t("composer.liveVoice.microphoneBlocked")
        : errorMessage(state.error, t("composer.liveVoice.error"));
    return t("composer.liveVoice.connecting");
  });
  const levels = createMemo(() =>
    live.state().microphoneLevels.map((level, index) => ({
      index,
      microphone: live.state().muted ? 0 : level,
      playback: live.state().playbackLevels[index] ?? 0,
    })),
  );

  return (
    <Show when={platform.appInfo()?.platform === "win32"}>
      <div class="live-voice-dock">
        <Show when={active()}>
          <section class="live-voice-panel" aria-label={t("composer.liveVoice.panel")}>
            <div class="live-voice-origin" role="img" aria-label={live.origin()?.agent.name}>
              <AgentAvatar agent={live.origin()?.agent} class="live-voice-avatar" />
            </div>
            <div
              class="live-voice-waveform"
              role="img"
              aria-label={`${t("composer.liveVoice.waveform")}. ${setStatus()}`}
            >
              <For each={levels()}>
                {(bar) => (
                  <span class="live-voice-wave-column" aria-hidden="true">
                    <i style={{ "--live-voice-level": `${Math.max(4, bar.playback)}%` }} />
                    <i style={{ "--live-voice-level": `${Math.max(4, bar.microphone)}%` }} />
                  </span>
                )}
              </For>
            </div>
            <Button
              variant="ghost"
              type="button"
              class={`live-voice-control${live.state().muted ? " live-voice-muted" : ""}`}
              aria-label={live.state().muted ? t("composer.liveVoice.unmute") : t("composer.liveVoice.mute")}
              aria-pressed={live.state().muted ? "true" : "false"}
              onClick={live.toggleMute}
            >
              <Show when={live.state().muted} fallback={<Mic aria-hidden="true" />}>
                <MicOff aria-hidden="true" />
              </Show>
            </Button>
            <Button
              variant="ghost"
              type="button"
              class="live-voice-control live-voice-stop"
              aria-label={t("composer.liveVoice.stop")}
              disabled={live.state().stopPending}
              onClick={() => void live.stop()}
            >
              <span class="live-voice-stop-mark" aria-hidden="true" />
            </Button>
            <span class="live-voice-sr-status" role="status" aria-live="polite">
              {setStatus()}
            </span>
            <span class="live-voice-visible-status">{setStatus()}</span>
          </section>
        </Show>
        <Show when={live.state().phase === "error" && !live.state().hostSessionActive}>
          <span class="live-voice-launch-error" role="status">
            {setStatus()}
          </span>
        </Show>
      </div>
    </Show>
  );
}
