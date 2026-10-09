import { Redirect } from "expo-router";

import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { SignInScreen } from "@/features/auth/screens/sign-in-screen";

export default function IndexRoute() {
  const { session } = useMobileSession();
  return session ? <Redirect href="/connected" /> : <SignInScreen />;
}
