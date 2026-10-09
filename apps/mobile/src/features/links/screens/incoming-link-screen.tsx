import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { openBrowserAsync } from "expo-web-browser";
import { Button, Typography } from "heroui-native";
import { Bot, UserPlus } from "lucide-react-native";
import { useContext, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { redeemMobileConnectUrl } from "@/features/auth/api/mobile-auth";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { SignInScreen } from "@/features/auth/screens/sign-in-screen";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";
import { SplashContentReadyContext } from "@/shared/lib/use-splash-gate";
import { findIncomingLink, forgetIncomingLink, pendingSignInLinkId, readIncomingLink } from "../model/incoming-links";

export function IncomingLinkScreen() {
  const { request } = useLocalSearchParams<{ request?: string }>();
  return <IncomingLinkContent key={request ?? "invalid"} request={request} />;
}

function IncomingLinkContent({ request }: { request?: string }) {
  const { t, errorMessage } = useText();
  const { session, connect } = useMobileSession();
  const reportContentReady = useContext(SplashContentReadyContext);
  const [link] = useState(() => (request ? findIncomingLink(request) : readIncomingLink(request)));
  const currentLink = link ?? { kind: "invalid" as const };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState(false);
  const restoreWorkspace = Boolean(session && (!request || !link));
  usePreventRemove(busy, () => {
    // Redemption saves a session. Keep this screen until that operation settles.
  });
  useEffect(() => {
    if (restoreWorkspace) router.replace("/connected");
  }, [restoreWorkspace]);
  useEffect(() => {
    if (!paired || busy) return;
    const pending = pendingSignInLinkId();
    router.replace(pending ? { pathname: "/incoming-link", params: { request: pending } } : "/connected");
  }, [paired, busy]);
  const opened = useRef(false);
  const signedIn = Boolean(session);
  useEffect(() => {
    if (currentLink.kind !== "template" || !signedIn || opened.current) return;
    opened.current = true;
    // Return to the running workspace, then open the sheet in its stack. A replace from this root
    // screen would mount a second workspace, which opens a second connection to each host. With no
    // workspace under this screen, `dismissTo` replaces this screen with one.
    router.dismissTo("/connected");
    router.push({ pathname: "/install-agent", params: { request } });
  }, [currentLink.kind, signedIn, request]);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function close() {
    if (locked.current) return;
    forgetIncomingLink(request);
    router.replace(session ? "/connected" : "/");
  }

  async function pair() {
    if (currentLink.kind !== "pairing" || session || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await redeemMobileConnectUrl(currentLink.url);
      connect(next);
      forgetIncomingLink(request);
      void haptics.notification("success");
      if (mounted.current) setPaired(true);
    } catch (cause) {
      void haptics.notification("error");
      if (mounted.current) setError(errorMessage(cause, t("mobile.link.connectFailed")));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  // Request IDs are intentionally process-local. A restored route can outlive its request record;
  // return an authenticated user to the workspace instead of replaying a one-use link or showing
  // an invalid-link error. This route reports layout readiness because the root splash gate waits
  // for route-owned screens, and a redirect itself does not lay out any content.
  if (restoreWorkspace) {
    return <View className="flex-1 bg-background" onLayout={() => reportContentReady()} />;
  }

  if (currentLink.kind === "invite") {
    if (session) return <Redirect href={{ pathname: "/add-server", params: { request } }} />;
    return (
      <SignInScreen
        notice={{
          icon: UserPlus,
          title: t("mobile.link.invite.signInTitle"),
          description: t("mobile.link.invite.signInDescription"),
          cancelLabel: t("mobile.link.invite.cancel"),
          onCancel: close,
        }}
      />
    );
  }

  if (currentLink.kind === "template") {
    if (session) return null;
    return (
      <SignInScreen
        notice={{
          icon: Bot,
          title: t("mobile.link.template.signInTitle"),
          description: t("mobile.link.template.signInDescription"),
          cancelLabel: t("common.cancel"),
          onCancel: close,
        }}
      />
    );
  }

  return (
    <View
      className="flex-1 justify-center gap-5 bg-background px-6 py-safe-offset-6"
      onLayout={() => reportContentReady()}
    >
      <Stack.Screen options={{ gestureEnabled: !busy, headerShown: false }} />
      <Typography.Heading type="h3">
        {currentLink.kind === "pairing"
          ? t("mobile.link.pairing.title")
          : currentLink.kind === "plugin"
            ? t("mobile.link.plugin.title")
            : t("mobile.link.unavailable.title")}
      </Typography.Heading>
      <Typography.Paragraph>
        {currentLink.kind === "pairing"
          ? session
            ? t("mobile.link.pairing.alreadySignedIn")
            : t("mobile.link.pairing.description")
          : currentLink.kind === "plugin"
            ? t("mobile.link.plugin.description")
            : t("mobile.link.unavailable.description")}
      </Typography.Paragraph>
      {error ? <Typography.Paragraph className="text-danger-text">{error}</Typography.Paragraph> : null}
      {currentLink.kind === "pairing" && !session ? (
        <Button isDisabled={busy} onPress={() => void pair()}>
          <Button.Label>{busy ? t("common.connecting") : t("mobile.link.pairing.connect")}</Button.Label>
        </Button>
      ) : null}
      {currentLink.kind === "plugin" ? (
        <Button
          onPress={() => {
            void haptics.impact("soft");
            void openBrowserAsync(currentLink.url).catch(() => {
              void haptics.notification("error");
              setError(t("mobile.link.plugin.openFailed"));
            });
          }}
        >
          <Button.Label>{t("mobile.link.plugin.view")}</Button.Label>
        </Button>
      ) : null}
      <Button
        variant="ghost"
        isDisabled={busy}
        onPress={() => {
          void haptics.impact("soft");
          close();
        }}
      >
        <Button.Label>{t("common.close")}</Button.Label>
      </Button>
    </View>
  );
}
