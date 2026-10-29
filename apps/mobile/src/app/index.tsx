import { router } from "expo-router";
import { useContext, useEffect } from "react";
import { View } from "react-native";

import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { SignInScreen } from "@/features/auth/screens/sign-in-screen";
import { SplashContentReadyContext } from "@/shared/lib/use-splash-gate";

export default function IndexRoute() {
  const { loading, session } = useMobileSession();
  const reportContentReady = useContext(SplashContentReadyContext);
  useEffect(() => {
    if (!loading && session?.sessionToken) router.replace("/connected");
  }, [loading, session?.sessionToken]);

  if (!loading && !session?.sessionToken) return <SignInScreen />;

  // Keep the splash visible while the saved identity session is restored.
  return (
    <View
      className="flex-1 bg-background"
      onLayout={() => reportContentReady()}
      accessibilityLabel={loading ? "Restoring account" : undefined}
    />
  );
}
