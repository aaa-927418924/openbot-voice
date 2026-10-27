import { Stack } from "expo-router/stack";
import { useCSSVariable } from "uniwind";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { isIOS } from "@/shared/lib/platform";
import { sheetBackHaptics } from "@/shared/lib/sheet-back-haptics";
import { sheetHeaderInsetOptions } from "@/shared/lib/sheet-header";
import { useText } from "@/shared/lib/text";

export const unstable_settings = { initialRouteName: "index" };

export default function ServerSettingsLayout() {
  const { t } = useText();
  const { session } = useMobileSession();
  const background = String(useCSSVariable("--openbot-bg-sheet"));
  return (
    <Stack
      screenListeners={sheetBackHaptics}
      screenOptions={{
        ...sheetHeaderInsetOptions,
        presentation: "card",
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
        headerTransparent: isIOS,
        headerStyle: { backgroundColor: isIOS ? "transparent" : background },
        headerBlurEffect: "none",
        scrollEdgeEffects: { top: "hidden", bottom: "soft" },
        contentStyle: { backgroundColor: background },
      }}
    >
      <Stack.Screen name="index" options={{ title: t("mobile.app.route.serverOptions") }} />
      <Stack.Protected guard={!session?.localOnly}>
        <Stack.Screen name="members" options={{ title: t("mobile.app.route.members") }} />
      </Stack.Protected>
      <Stack.Screen name="crop-logo" options={{ title: t("mobile.server.route.cropLogo") }} />
    </Stack>
  );
}
