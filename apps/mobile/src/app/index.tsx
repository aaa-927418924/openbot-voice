import { router } from "expo-router";
import { useContext, useEffect } from "react";
import { View } from "react-native";

import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { SignInScreen } from "@/features/auth/screens/sign-in-screen";
import { SplashContentReadyContext } from "@/shared/lib/use-splash-gate";

export default function IndexRoute() {
  const { session } = useMobileSession();
  const reportContentReady = useContext(SplashContentReadyContext);
  useEffect(() => {
    if (session) router.replace("/connected");
  }, [session]);

  // The root splash waits for route-owned layout. Keep a readiness signal while an
  // authenticated startup route replaces itself with the workspace.
  return session ? <View className="flex-1 bg-background" onLayout={() => reportContentReady()} /> : <SignInScreen />;
}
