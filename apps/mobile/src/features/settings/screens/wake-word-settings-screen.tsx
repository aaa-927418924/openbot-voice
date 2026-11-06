import * as Notifications from "expo-notifications";
import { useFocusEffect } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Check, Mic, MicOff } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Alert, PermissionsAndroid, Platform } from "react-native";
import { useMobileLiveVoice } from "@/features/live-voice/context/mobile-live-voice-context";
import { ensureMicrophonePermission } from "@/features/live-voice/model/android-microphone-permission";
import {
  getWakeWordStatus,
  saveWakeWordTarget,
  startWakeWordListening,
  stopWakeWordListening,
  type WakeWordStatus,
} from "@/features/live-voice/model/live-voice-background-service";
import {
  SettingsContent,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-content";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { useText } from "@/shared/lib/text";

const EMPTY_STATUS: WakeWordStatus = {
  armed: false,
  listening: false,
  starting: false,
  serverId: null,
  agentId: null,
  agentName: null,
  avatarHue: null,
};

export function WakeWordSettingsScreen() {
  const { t } = useText();
  const workspace = useMobileWorkspace();
  const liveVoice = useMobileLiveVoice();
  const foreground = useThemeColor("foreground");
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [saving, setSaving] = useState(false);

  const supportedAgents = useMemo(
    () =>
      workspace.agents.filter(
        (agent) =>
          agent.provider === "codex" &&
          workspace.servers.some(
            (server) =>
              server.id === agent.serverId &&
              server.state === "online" &&
              workspace.supportsLiveVoice(server.id, false),
          ),
      ),
    [workspace.agents, workspace.servers, workspace.supportsLiveVoice],
  );
  const selectedAgent = supportedAgents.find(
    (agent) => agent.id === status.agentId && agent.serverId === status.serverId,
  );
  const voiceActive = liveVoice.state.phase !== "idle";

  const refreshStatus = useCallback(async () => {
    setStatus(await getWakeWordStatus());
  }, []);

  useFocusEffect(
    useCallback(() => {
      let focused = true;
      const pollStatus = async () => {
        const current = await getWakeWordStatus();
        if (focused) setStatus(current);
      };
      void pollStatus();
      const interval = setInterval(() => void pollStatus(), 1500);
      return () => {
        focused = false;
        clearInterval(interval);
      };
    }, []),
  );

  const selectAgent = useCallback(
    async (agentId: string, serverId: string) => {
      const agent = supportedAgents.find((item) => item.id === agentId && item.serverId === serverId);
      if (!agent) return;
      setSaving(true);
      try {
        if (status.armed) await stopWakeWordListening();
        await saveWakeWordTarget({
          agentId: agent.id,
          serverId: agent.serverId,
          agentName: agent.name,
          avatarHue: agent.avatarHue,
        });
        await refreshStatus();
      } catch {
        Alert.alert(t("mobile.settings.wakeWord.title"), t("mobile.settings.wakeWord.saveFailed"));
      } finally {
        setSaving(false);
      }
    },
    [refreshStatus, status.armed, supportedAgents, t],
  );

  const toggleListening = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (status.armed) {
        await stopWakeWordListening();
        await refreshStatus();
        return;
      }
      if (!selectedAgent) {
        Alert.alert(t("mobile.settings.wakeWord.title"), t("mobile.settings.wakeWord.selectFirst"));
        return;
      }

      const microphoneGranted = await ensureMicrophonePermission({
        hasPermission: () => PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO),
        requestPermission: async () =>
          (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) ===
          PermissionsAndroid.RESULTS.GRANTED,
      });
      if (!microphoneGranted) {
        Alert.alert(t("mobile.settings.wakeWord.title"), t("mobile.settings.wakeWord.microphoneDenied"));
        return;
      }

      await Notifications.setNotificationChannelAsync("wake_word_listener", {
        name: t("mobile.settings.wakeWord.notificationChannel"),
        importance: Notifications.AndroidImportance.LOW,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      });
      const existing = await Notifications.getPermissionsAsync();
      const permission = existing.status === "granted" ? existing : await Notifications.requestPermissionsAsync();
      if (permission.status !== "granted") {
        Alert.alert(t("mobile.settings.wakeWord.title"), t("mobile.settings.wakeWord.notificationsDenied"));
        return;
      }

      await startWakeWordListening();
      await refreshStatus();
    } catch {
      Alert.alert(t("mobile.settings.wakeWord.title"), t("mobile.settings.wakeWord.startFailed"));
      await refreshStatus();
    } finally {
      setSaving(false);
    }
  }, [refreshStatus, saving, selectedAgent, status.armed, t]);

  const statusText = status.listening
    ? t("mobile.settings.wakeWord.listening")
    : status.starting
      ? t("mobile.settings.wakeWord.starting")
      : status.armed
        ? voiceActive
          ? t("mobile.settings.wakeWord.pausedCall")
          : t("mobile.settings.wakeWord.heard")
        : t("mobile.settings.wakeWord.stopped");

  return (
    <SettingsContent>
      {Platform.OS === "android" ? (
        <>
          <SettingsSection title={t("mobile.settings.wakeWord.statusTitle")}>
            <SettingsRow
              onPress={() => void toggleListening()}
              disabled={saving || (!status.armed && !selectedAgent)}
              disclosure={false}
              trailing={
                status.armed ? (
                  <MicOff size={19} color={String(foreground)} strokeWidth={1.7} />
                ) : (
                  <Mic size={19} color={String(foreground)} strokeWidth={1.7} />
                )
              }
              supportingText={statusText}
            >
              <Typography.Paragraph type="body-sm">
                {status.armed ? t("mobile.settings.wakeWord.stop") : t("mobile.settings.wakeWord.start")}
              </Typography.Paragraph>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection
            title={t("mobile.settings.wakeWord.selectBot")}
            footer={supportedAgents.length === 0 ? t("mobile.settings.wakeWord.noBots") : undefined}
          >
            {supportedAgents.map((agent) => {
              const selected = agent.id === status.agentId && agent.serverId === status.serverId;
              const serverName = workspace.servers.find((server) => server.id === agent.serverId)?.name ?? "";
              return (
                <SettingsRow
                  key={`${agent.serverId}:${agent.id}`}
                  onPress={() => void selectAgent(agent.id, agent.serverId)}
                  disabled={saving || (status.armed && selected)}
                  disclosure={false}
                  trailing={selected ? <Check size={19} color={String(foreground)} strokeWidth={2} /> : null}
                  supportingText={serverName}
                >
                  <Typography.Paragraph type="body-sm">{agent.name}</Typography.Paragraph>
                </SettingsRow>
              );
            })}
          </SettingsSection>

          <SettingsNote>{t("mobile.settings.wakeWord.privacy")}</SettingsNote>
        </>
      ) : (
        <Typography.Paragraph>{t("mobile.settings.wakeWord.androidOnly")}</Typography.Paragraph>
      )}
    </SettingsContent>
  );
}
