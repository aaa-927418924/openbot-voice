import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Eye } from "lucide-react-native";
import { Alert, View } from "react-native";
import type { MobileSession } from "@/features/auth/api/mobile-auth";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { useServerVisibility } from "@/features/servers/model/server-visibility";
import { SettingsContent, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import type { MobileServer } from "@/features/workspace/context/mobile-workspace-context";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { haptics } from "@/shared/lib/haptics";
import { currentText, useText } from "@/shared/lib/text";

function HiddenServersContent({ session, servers }: { session: MobileSession; servers: MobileServer[] }) {
  const { t } = useText();
  const { hiddenServerIds, showServer, showAllServers } = useServerVisibility(session.apiUrl, session.user.id);
  const hidden = new Set(hiddenServerIds);
  const hiddenServers = servers.filter((server) => hidden.has(server.id));
  const foreground = String(useThemeColor("foreground"));

  function show(serverId: string) {
    try {
      showServer(serverId);
      void haptics.notification();
    } catch (error) {
      void haptics.notification("error");
      const text = currentText();
      Alert.alert(
        t("mobile.settings.servers.hiddenSaveFailed"),
        text.errorMessage(error, t("mobile.settings.saveFailed")),
      );
    }
  }

  function showAll() {
    try {
      showAllServers();
      void haptics.notification();
    } catch (error) {
      void haptics.notification("error");
      const text = currentText();
      Alert.alert(
        t("mobile.settings.servers.hiddenSaveFailed"),
        text.errorMessage(error, t("mobile.settings.saveFailed")),
      );
    }
  }

  return (
    <SettingsContent>
      <SettingsSection footer={t("mobile.settings.servers.hiddenDescription")}>
        {hiddenServers.length ? (
          hiddenServers.map((server) => (
            <SettingsRow
              key={server.id}
              accessibilityLabel={t("mobile.settings.servers.hiddenShowNamed", { name: server.name })}
              onPress={() => show(server.id)}
              trailing={<Eye color={foreground} size={18} strokeWidth={1.8} />}
            >
              <Typography.Paragraph type="body-sm" numberOfLines={1}>
                {server.name}
              </Typography.Paragraph>
            </SettingsRow>
          ))
        ) : (
          <View className="px-4 py-3">
            <Typography.Paragraph type="body-sm" className="text-grouped-secondary">
              {t("mobile.settings.servers.hiddenEmpty")}
            </Typography.Paragraph>
          </View>
        )}
        {hiddenServers.length > 1 ? (
          <SettingsRow onPress={showAll}>
            <Typography.Paragraph type="body-sm" weight="semibold">
              {t("mobile.settings.servers.hiddenShowAll")}
            </Typography.Paragraph>
          </SettingsRow>
        ) : null}
      </SettingsSection>
    </SettingsContent>
  );
}

export function HiddenServersScreen() {
  const { session } = useMobileSession();
  const { servers } = useMobileWorkspace();
  return session ? <HiddenServersContent session={session} servers={servers} /> : null;
}
