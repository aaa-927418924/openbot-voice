import type { AgentProfile } from "@openbot/ui/data";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { createSimpleContext } from "../../simple-context";
import { createLiveVoiceController, type LiveVoiceState } from "./live-voice-controller";
import { liveVoicePort } from "./live-voice-port";

export interface LiveVoiceOrigin {
  agentId: string;
  threadId: string;
  serverId: string;
  /** Present only when the call started from a single-agent channel composer. */
  channelId?: string;
  agent: Pick<AgentProfile, "id" | "name" | "provider" | "avatarSeed" | "avatarHue" | "avatarUrl">;
}

const IDLE: LiveVoiceState = {
  phase: "idle",
  audioBlocked: false,
  microphoneBlocked: false,
  hostSessionActive: false,
  stopPending: false,
  muted: false,
  microphoneLevels: Array(16).fill(0),
  playbackLevels: Array(16).fill(0),
};

const LiveVoice = createSimpleContext({
  name: "LiveVoice",
  init: () => {
    const [state, setState] = createSignal<LiveVoiceState>(IDLE);
    const [origin, setOrigin] = createSignal<LiveVoiceOrigin>();
    const api = liveVoicePort();
    const controller = createLiveVoiceController(api, setState);
    createEffect(
      () => {
        const current = state();
        return !current.hostSessionActive && (current.phase === "idle" || current.phase === "error");
      },
      (shouldClearOrigin) => {
        if (shouldClearOrigin) setOrigin(undefined);
      },
    );
    const start = (target: LiveVoiceOrigin): void => {
      if (!api || state().hostSessionActive || state().phase === "connecting") return;
      setOrigin(target);
      void controller.start({ agentId: target.agentId, threadId: target.threadId, serverId: target.serverId });
    };
    const stop = () => controller.stop();
    const toggleMute = () => controller.toggleMute();
    const sendText = (text: string) => controller.sendText(text);
    const resumeAudio = () => controller.resumeAudio();
    onCleanup(() => controller.dispose());
    return { state, origin, available: () => Boolean(api), start, stop, toggleMute, sendText, resumeAudio };
  },
});

export const LiveVoiceProvider = LiveVoice.provider;
export const useLiveVoice = LiveVoice.use;
