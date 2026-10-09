import { router } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Copy, Reply, TextSelect, Trash2 } from "lucide-react-native";
import { useRef } from "react";
import { Alert } from "react-native";
import { useCopyMessage } from "@/features/chat/components/use-copy-message";
import { useMessageActions } from "@/features/chat/context/message-actions-context";
import { SettingsContent, SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { haptics } from "@/shared/lib/haptics";
import { currentText, useText } from "@/shared/lib/text";

export default function MessageActionsScreen() {
  const { t } = useText();
  const { selected } = useMessageActions();
  const foreground = useThemeColor("foreground");
  const { copy } = useCopyMessage(selected?.message.body ?? "");
  const deleting = useRef(false);
  if (!selected) return null;
  const deleteMessage = () => {
    if (!selected.onDelete || deleting.current) return;
    Alert.alert(t("mobile.app.messageActions.deleteTitle"), t("mobile.app.messageActions.deleteBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: () => {
          if (deleting.current) return;
          deleting.current = true;
          void selected
            .onDelete?.()
            .then(() => {
              void haptics.notification();
              router.back();
            })
            .catch((error: unknown) => {
              void haptics.notification("error");
              const text = currentText();
              Alert.alert(
                text.t("mobile.app.messageActions.deleteFailed"),
                text.errorMessage(error, text.t("mobile.app.messageActions.deleteFailedBody")),
              );
            })
            .finally(() => {
              deleting.current = false;
            });
        },
      },
    ]);
  };
  return (
    <SettingsContent>
      <SettingsSection>
        <SettingsRow
          leading={<Reply color={foreground} size={22} />}
          disclosure={false}
          disabled={!selected.onReply}
          onPress={() => {
            selected.onReply?.();
            router.back();
          }}
        >
          <Typography>{t("mobile.app.messageActions.reply")}</Typography>
        </SettingsRow>
        {selected.onDelete ? (
          <SettingsRow leading={<Trash2 color={foreground} size={22} />} disclosure={false} onPress={deleteMessage}>
            <Typography>{t("mobile.app.messageActions.delete")}</Typography>
          </SettingsRow>
        ) : null}
        <SettingsRow
          leading={<Copy color={foreground} size={22} />}
          disclosure={false}
          onPress={async () => {
            if (await copy()) router.back();
          }}
        >
          <Typography>{t("common.copy")}</Typography>
        </SettingsRow>
        <SettingsRow
          leading={<TextSelect color={foreground} size={22} />}
          onPress={() => router.push("/message-actions/select-text")}
        >
          <Typography>{t("mobile.app.messageActions.selectText")}</Typography>
        </SettingsRow>
      </SettingsSection>
    </SettingsContent>
  );
}
