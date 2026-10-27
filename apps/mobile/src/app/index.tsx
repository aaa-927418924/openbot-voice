import { router } from "expo-router";
import { useContext, useEffect } from "react";
import { View } from "react-native";

import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { SplashContentReadyContext } from "@/shared/lib/use-splash-gate";

export default function IndexRoute() {
  const { loading, session } = useMobileSession();
  const reportContentReady = useContext(SplashContentReadyContext);
  useEffect(() => {
    if (session) router.replace("/connected");
  }, [session]);

  // Local-only startup never exposes an account sign-in page. The splash covers this view while
  // the on-device profile is loaded and the workspace route replaces it.
  return (
    <View
      className="flex-1 bg-background"
      onLayout={() => reportContentReady()}
      accessibilityLabel={loading ? "Loading local profile" : undefined}
    />
  );
}
