import { serverGradientLogoProfile } from "@openbot/brand/server-gradient-logo";
import MaskedView from "@react-native-masked-view/masked-view";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { Monitor } from "lucide-react-native";
import { useId, useState } from "react";
import { View } from "react-native";
import Svg, { Defs, Ellipse, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { useCSSVariable } from "uniwind";
import { thumbnailColor } from "@/features/agents/components/bloub-avatar";
import { getBloubAvatarColor } from "@/features/agents/model/bloub-activity";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { loadServerLogo } from "@/features/servers/model/server-logo";
import { DISCONNECTED_APPEARANCE } from "@/features/workspace/components/use-connection-appearance";
import type { MobileServer } from "@/features/workspace/model/workspace-types";

const INK = "rgba(0, 0, 0, 0.72)";
const DOT = 12;
const DOT_OVERHANG = 2;
// The ring cut out of the squircle around the dot, so the dot works on any background.
const DOT_GAP = 2.5;

/** A square with a circular hole around the dot. The mask keeps only the filled part. */
function cutoutPath(size: number): string {
  const center = size + DOT_OVERHANG - DOT / 2;
  const radius = DOT / 2 + DOT_GAP;
  return `M0 0H${size}V${size}H0Z M${center - radius} ${center}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0Z`;
}

function ServerGradientFallback({ seed, size }: { seed: string; size: number }) {
  const profile = serverGradientLogoProfile(seed);
  const gradientPrefix = useId().replace(/[^a-zA-Z0-9_-]/gu, "");
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Rect width={size} height={size} fill={profile.colors[0]} />
      <Defs>
        {profile.blobs.map((blob) => {
          const id = `${gradientPrefix}-server-gradient-${blob.color.slice(1)}`;
          return (
            <RadialGradient
              key={id}
              id={id}
              gradientUnits="userSpaceOnUse"
              cx={(blob.x * size) / 100}
              cy={(blob.y * size) / 100}
              fx={(blob.x * size) / 100}
              fy={(blob.y * size) / 100}
              rx={(blob.width * size) / 100}
              ry={(blob.height * size) / 100}
            >
              <Stop offset="0%" stopColor={blob.color} />
              <Stop offset={`${blob.solidStop}%`} stopColor={blob.color} />
              <Stop offset={`${blob.fadeStop}%`} stopColor={blob.color} stopOpacity="0" />
            </RadialGradient>
          );
        })}
      </Defs>
      {profile.blobs
        .slice()
        .reverse()
        .map((blob) => (
          <Ellipse
            key={`${gradientPrefix}-blob-${blob.color.slice(1)}`}
            cx={(blob.x * size) / 100}
            cy={(blob.y * size) / 100}
            rx={(blob.width * size) / 100}
            ry={(blob.height * size) / 100}
            fill={`url(#${gradientPrefix}-server-gradient-${blob.color.slice(1)})`}
          />
        ))}
    </Svg>
  );
}

/**
 * A squircle with the server logo, or a generated server gradient, and a dot for the
 * connection state. `logoUri` replaces the saved logo with a draft; `null` shows no logo.
 * `showStatus={false}` leaves out the dot and the dimming, for a place that shows the logo only.
 */
export function ServerAvatar({
  server,
  size = 48,
  logoUri,
  showStatus = true,
}: {
  server: MobileServer;
  size?: number;
  logoUri?: string | null;
  showStatus?: boolean;
}) {
  const { session, sessionScope } = useMobileSession();
  const { logoKey } = server;
  const saved = useQuery({
    queryKey: ["server-logo", session?.apiUrl, session?.user.id, sessionScope, server.id, logoKey],
    enabled: logoUri === undefined && Boolean(session && !session.localOnly && logoKey),
    queryFn: () => {
      if (!session || !logoKey) throw new Error("The server logo is unavailable.");
      return loadServerLogo(session, server.id, logoKey);
    },
    // The event that names a new logo can arrive before the host has uploaded it.
    retry: 4,
    staleTime: Infinity,
  });
  const logo = logoUri === undefined ? (saved.data ?? null) : logoUri;
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const logoFailed = logo === failedUri;
  const success = String(useCSSVariable("--openbot-success"));
  const warning = String(useCSSVariable("--openbot-warning"));
  const danger = String(useCSSVariable("--openbot-danger"));
  const offline = String(useCSSVariable("--openbot-text-dim"));
  const dot =
    server.state === "online"
      ? success
      : server.state === "error"
        ? danger
        : server.state === "connecting" && server.initialConnectionPending
          ? warning
          : offline;
  const muted = showStatus && server.state !== "online";
  const tile = (
    <View
      className="items-center justify-center"
      style={{
        backgroundColor: thumbnailColor(getBloubAvatarColor(server.id, null), muted),
        borderCurve: "continuous",
        borderRadius: size * 0.32,
        height: size,
        opacity: muted ? DISCONNECTED_APPEARANCE.opacity : 1,
        overflow: "hidden",
        width: size,
      }}
    >
      {server.kind === "local" ? (
        <Monitor color={INK} size={size * 0.42} strokeWidth={2} />
      ) : (
        <ServerGradientFallback seed={server.id} size={size} />
      )}
      {logo && !logoFailed ? (
        <Image
          source={{ uri: logo }}
          contentFit="cover"
          recyclingKey={logo}
          style={{ height: size, position: "absolute", width: size }}
          onError={() => setFailedUri(logo)}
        />
      ) : null}
    </View>
  );
  if (!showStatus)
    return (
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {tile}
      </View>
    );
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <MaskedView
        style={{ height: size, width: size }}
        maskElement={
          <Svg height={size} width={size}>
            <Path d={cutoutPath(size)} fill="#000" fillRule="evenodd" />
          </Svg>
        }
      >
        {tile}
      </MaskedView>
      <View
        className="absolute rounded-full"
        style={{
          backgroundColor: dot,
          bottom: -DOT_OVERHANG,
          height: DOT,
          right: -DOT_OVERHANG,
          width: DOT,
        }}
      />
    </View>
  );
}
