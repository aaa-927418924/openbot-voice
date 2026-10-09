import { type Href, router, useLocalSearchParams } from "expo-router";
import { useContext, useEffect, useState } from "react";
import { View } from "react-native";
import { forgetIncomingLink, readIncomingLink } from "@/features/links/model/incoming-links";
import { SplashContentReadyContext } from "@/shared/lib/use-splash-gate";
import { AddServerScreen } from "./add-server-screen";

interface SheetPlacement {
  /** The scanner page of the sheet that shows this page. */
  scanHref?: Href;
  /** An inner page under a native header. */
  underHeader?: boolean;
}

export function AddServerLinkScreen(placement: SheetPlacement = {}) {
  const { request } = useLocalSearchParams<{ request?: string }>();
  const reportContentReady = useContext(SplashContentReadyContext);
  return (
    <View className="flex-1" onLayout={() => reportContentReady()}>
      <Invitation key={request ?? "manual"} request={request} {...placement} />
    </View>
  );
}

// A deep link and the scanner both hand over the invitation through the request store, so its
// one-use token never enters navigation params.
function Invitation({ request, ...placement }: { request?: string } & SheetPlacement) {
  const [link] = useState(() => readIncomingLink(request));
  useEffect(() => {
    forgetIncomingLink(request);
  }, [request]);
  return (
    <AddServerScreen
      initialInvite={link.kind === "invite" ? link.url : ""}
      onJoined={() => router.dismissTo("/connected")}
      {...placement}
    />
  );
}
