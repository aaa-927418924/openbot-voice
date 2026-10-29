import { router } from "expo-router";
import { Typography } from "heroui-native";
import { useRef, useState } from "react";
import { Keyboard } from "react-native";
import { normalizeIdentityServerAddress, saveIdentityServerAddress } from "@/features/auth/api/mobile-auth";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { SheetSaveAction } from "@/shared/components/sheet-save-action";
import { SheetScrollView } from "@/shared/components/sheet-scroll-view";
import { haptics } from "@/shared/lib/haptics";
import { useText } from "@/shared/lib/text";

export function IdentityServerSettingsScreen() {
  const { session, signOut } = useMobileSession();
  const { t, errorMessage } = useText();
  const initialAddress = normalizeIdentityServerAddress(session?.apiUrl ?? "") ?? session?.apiUrl ?? "";
  const [address, setAddress] = useState(initialAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const normalizedAddress = normalizeIdentityServerAddress(address);
  const dirty = address !== initialAddress;
  const canSave = Boolean(session?.sessionToken && normalizedAddress && normalizedAddress !== initialAddress && !busy);

  async function applyAddress(): Promise<void> {
    if (locked.current || !session?.sessionToken || !normalizedAddress || !canSave) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await saveIdentityServerAddress(normalizedAddress);
      await signOut();
      Keyboard.dismiss();
      void haptics.notification("success");
      router.replace("/");
    } catch (cause) {
      setError(errorMessage(cause, t("mobile.settings.identityServer.saveFailed")));
      void haptics.notification("error");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <SheetScrollView
      className="bg-sheet"
      contentContainerClassName="gap-5 px-5 pb-safe-offset-5"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      <SheetSaveAction
        dirty={dirty}
        canSave={canSave}
        pending={busy}
        label={t("mobile.settings.identityServer.apply")}
        pendingLabel={t("mobile.settings.identityServer.applying")}
        onSave={() => void applyAddress()}
      />
      <SheetFormField
        label={t("mobile.auth.signIn.serverAddress")}
        hint={t("mobile.auth.signIn.serverHint")}
        inputMode="url"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        returnKeyType="done"
        value={address}
        onChangeText={(value) => {
          setAddress(value);
          setError(null);
        }}
        onSubmitEditing={() => void applyAddress()}
      />
      {error ? (
        <Typography.Paragraph accessibilityRole="alert" className="text-danger-text">
          {error}
        </Typography.Paragraph>
      ) : null}
    </SheetScrollView>
  );
}
