import { router, useLocalSearchParams } from "expo-router";
import { useThemeColor } from "heroui-native/hooks";
import { ArrowLeft } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { useText } from "@/shared/lib/text";

export default function RemoteDesktopScreen() {
  const { serverId } = useLocalSearchParams<{ serverId?: string }>();
  const foreground = useThemeColor("foreground");
  const background = useThemeColor("background");
  const { t } = useText();
  const { openRemoteDesktop, closeRemoteDesktop, remoteDesktopSession } = useMobileWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const session = useRef<{ serverId: string; id: string } | null>(null);

  useEffect(() => {
    if (typeof serverId !== "string" || !serverId) {
      setError(t("mobile.remoteDesktop.openFailed"));
      setLoading(false);
      return;
    }
    let disposed = false;
    void openRemoteDesktop(serverId).then(
      (created) => {
        session.current = { serverId, id: created.id };
        if (disposed) void closeRemoteDesktop(serverId, created.id).catch(() => undefined);
        else setLoading(false);
      },
      (cause: unknown) => {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : t("mobile.remoteDesktop.openFailed"));
        setLoading(false);
      },
    );
    return () => {
      disposed = true;
      const active = session.current;
      session.current = null;
      if (active) void closeRemoteDesktop(active.serverId, active.id).catch(() => undefined);
    };
  }, [serverId, openRemoteDesktop, closeRemoteDesktop, t]);

  useEffect(() => {
    if (session.current && remoteDesktopSession === null) router.back();
  }, [remoteDesktopSession]);

  return (
    <View className="flex-1 items-center justify-center px-6" style={{ backgroundColor: String(background) }}>
      {loading ? (
        <>
          <ActivityIndicator color={String(foreground)} />
          <Text className="mt-4 text-center" style={{ color: String(foreground) }}>
            {t("mobile.remoteDesktop.workspaceLabel")}
          </Text>
        </>
      ) : (
        <>
          <Text className="text-center" style={{ color: String(foreground) }}>
            {error ?? t("mobile.remoteDesktop.viewerTitle")}
          </Text>
          {error ? (
            <Pressable
              accessibilityRole="button"
              className="mt-5 h-11 flex-row items-center gap-2 rounded-full bg-white/10 px-4"
              onPress={() => router.back()}
            >
              <ArrowLeft color={String(foreground)} size={18} />
              <Text style={{ color: String(foreground) }}>{t("mobile.remoteDesktop.back")}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}
