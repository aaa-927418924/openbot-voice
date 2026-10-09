import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Mic, MicOff, PhoneOff, Volume2 } from "lucide-react-native";
import { View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { BloubAvatar } from "@/features/agents/components/bloub-avatar";
import { useText } from "@/shared/lib/text";
import { useMobileLiveVoice } from "../context/mobile-live-voice-context";
import type { MobileLiveVoiceState } from "../model/live-voice";

export function LiveVoiceSessionCard({ topInset }: { topInset: number }) {
  const voice = useMobileLiveVoice();
  const { t, format } = useText();
  const reduceMotion = useReducedMotion();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const origin = voice.origin;
  if (!origin) return null;

  const state = voice.state;
  const elapsedSeconds = Math.floor(state.elapsedMs / 1000);
  const clock = `${format.number(Math.floor(elapsedSeconds / 60), { minimumIntegerDigits: 2, useGrouping: false })}:${format.number(elapsedSeconds % 60, { minimumIntegerDigits: 2, useGrouping: false })}`;
  const status = voiceStatus(state, t);
  const error = state.error ? voiceError(state, t) : null;
  const canStop = state.hostSessionActive || state.phase === "connecting";

  return (
    <View
      accessibilityViewIsModal={false}
      className="absolute inset-x-4 rounded-grouped border border-grouped-border bg-grouped px-3 py-3"
      pointerEvents="box-none"
      style={{ elevation: 8, top: topInset + 64, zIndex: 15 }}
    >
      <View className="flex-row items-center gap-3">
        <BloubAvatar
          agentId={origin.target.agentId}
          serverId={origin.target.serverId}
          hue={origin.target.avatarHue}
          seed={origin.target.avatarSeed}
          size={36}
        />
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row items-center justify-between gap-2">
            <Typography.Paragraph className="min-w-0 flex-1" weight="semibold" numberOfLines={1}>
              {origin.target.agentName}
            </Typography.Paragraph>
            <Typography.Paragraph
              type="body-xs"
              className="text-grouped-secondary"
              accessibilityLabel={t("mobile.liveVoice.elapsed", { time: clock })}
            >
              {clock}
            </Typography.Paragraph>
          </View>
          <Typography.Paragraph
            type="body-xs"
            className={error ? "text-danger-text" : "text-grouped-secondary"}
            numberOfLines={2}
          >
            {error ?? status}
          </Typography.Paragraph>
        </View>
        <Button
          isIconOnly
          variant="ghost"
          className="size-10 rounded-full bg-background"
          accessibilityLabel={state.muted ? t("mobile.liveVoice.unmute") : t("mobile.liveVoice.mute")}
          isDisabled={!state.hostSessionActive}
          onPress={voice.toggleMute}
        >
          {state.muted ? <MicOff color={String(foreground)} size={20} /> : <Mic color={String(foreground)} size={20} />}
        </Button>
        {state.audioBlocked ? (
          <Button
            isIconOnly
            variant="ghost"
            className="size-10 rounded-full bg-background"
            accessibilityLabel={t("mobile.liveVoice.resumeAudio")}
            onPress={voice.resumeAudio}
          >
            <Volume2 color={String(foreground)} size={20} />
          </Button>
        ) : null}
        <Button
          isIconOnly
          variant="ghost"
          className="size-10 rounded-full bg-background"
          accessibilityLabel={t("mobile.liveVoice.stop")}
          isDisabled={!canStop || state.phase === "stopping"}
          onPress={voice.stop}
        >
          <PhoneOff color={String(foreground)} size={20} />
        </Button>
      </View>
      <View className="mt-3 flex-row items-center gap-3">
        <Waveform
          levels={state.microphoneLevels}
          label={t("mobile.liveVoice.microphoneActivity")}
          reduceMotion={reduceMotion}
          color={String(foreground)}
        />
        <Waveform
          levels={state.playbackLevels}
          label={t("mobile.liveVoice.playbackActivity")}
          reduceMotion={reduceMotion}
          color={String(muted)}
        />
      </View>
    </View>
  );
}

function Waveform({
  levels,
  label,
  reduceMotion,
  color,
}: {
  levels: number[];
  label: string;
  reduceMotion: boolean;
  color: string;
}) {
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="image"
      className="h-6 flex-1 flex-row items-center justify-center gap-1"
    >
      {WAVEFORM_BAR_KEYS.map((key, index) => (
        <View
          key={key}
          className="w-1 rounded-full"
          style={{
            backgroundColor: color,
            height: reduceMotion ? 4 : Math.max(3, 3 + ((levels[index] ?? 0) / 100) * 20),
            opacity: (levels[index] ?? 0) > 4 ? 0.9 : 0.35,
          }}
        />
      ))}
    </View>
  );
}

const WAVEFORM_BAR_KEYS = Array.from({ length: 16 }, (_, index) => `waveform-${index}`);

function voiceStatus(state: MobileLiveVoiceState, t: ReturnType<typeof useText>["t"]): string {
  switch (state.phase) {
    case "connecting":
      return t("mobile.liveVoice.status.connecting");
    case "live":
      return t("mobile.liveVoice.status.live");
    case "stopping":
      return t("mobile.liveVoice.status.stopping");
    case "error":
      return state.hostSessionActive ? t("mobile.liveVoice.status.cleanupNeeded") : t("mobile.liveVoice.status.ended");
    case "idle":
      return t("mobile.liveVoice.status.ended");
  }
}

function voiceError(state: MobileLiveVoiceState, t: ReturnType<typeof useText>["t"]): string {
  if (state.error === "microphone") return t("mobile.liveVoice.error.microphone");
  if (state.error === "stop") return t("mobile.liveVoice.error.stop");
  return t("mobile.liveVoice.error.unavailable");
}
