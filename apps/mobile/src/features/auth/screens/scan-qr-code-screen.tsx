import { useRouter } from "expo-router";
import { mobileAnalytics } from "@/features/analytics/mobile-analytics";
import { redeemMobileConnectUrl } from "@/features/auth/api/mobile-auth";
import { QrScanner } from "@/features/auth/components/qr-scanner";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";

export function ScanQrCodeScreen() {
  const router = useRouter();
  const { connect: finishSignIn } = useMobileSession();
  return (
    <QrScanner
      onScan={async (data) => {
        const session = await mobileAnalytics.operation("mobile_pairing_action", { action: "redeem" }, () =>
          redeemMobileConnectUrl(data),
        );
        finishSignIn(session);
        if (router.canGoBack()) router.back();
        else router.replace("/connected");
      }}
    />
  );
}
