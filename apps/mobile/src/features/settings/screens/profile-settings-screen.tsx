import { validateProfileName } from "@openbot/contracts/validation";
import { router } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Camera, ChevronUp } from "lucide-react-native";
import { useRef, useState } from "react";
import { Alert, Keyboard, Pressable, View } from "react-native";
import { mobileUserName } from "@/features/auth/api/mobile-user-name";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { ProfileAvatar } from "@/shared/components/profile-avatar";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { SheetSaveAction } from "@/shared/components/sheet-save-action";
import { SheetScrollView } from "@/shared/components/sheet-scroll-view";
import { haptics } from "@/shared/lib/haptics";
import { pickAvatarPhoto } from "@/shared/lib/pick-avatar-photo";
import { useText } from "@/shared/lib/text";

export function ProfileSettingsScreen() {
  const { session, updateProfile, configureCredentials, signOut } = useMobileSession();
  const { t, errorMessage } = useText();
  const foreground = useThemeColor("foreground");
  const savedName = session ? mobileUserName(session.user) : "";
  const [draftName, setDraftName] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"name" | "photo" | "credentials" | "sign-out" | null>(null);
  const locked = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialsEmail, setCredentialsEmail] = useState("");
  const [credentialsPassword, setCredentialsPassword] = useState("");
  const [credentialsConfirmation, setCredentialsConfirmation] = useState("");
  const [editingInformation, setEditingInformation] = useState(false);
  if (!session) return null;
  const savedEmail = session.user.email;
  const busy = pendingAction !== null;
  const name = draftName ?? savedName;
  const validatedName = validateProfileName(name);
  const nameChanged = name.trim() !== savedName;
  const nameError =
    nameChanged && validatedName.error
      ? validatedName.error === "unsafe"
        ? t("mobile.settings.profile.nameUnsafe")
        : t("mobile.settings.profile.nameLength")
      : null;
  const hasConfiguredCredentials = Boolean(savedEmail);
  const normalizedCredentialsEmail = credentialsEmail.trim().toLowerCase();
  const emailChanged = normalizedCredentialsEmail !== savedEmail;
  const passwordRequested = credentialsPassword.length > 0 || credentialsConfirmation.length > 0;
  const credentialsDirty = editingInformation && (emailChanged || passwordRequested);
  const credentialsEmailValid =
    Boolean(normalizedCredentialsEmail) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizedCredentialsEmail);
  const credentialsError = credentialsDirty
    ? !normalizedCredentialsEmail
      ? t("mobile.settings.profile.credentialsRequired")
      : !credentialsEmailValid
        ? t("mobile.settings.profile.credentialsEmailInvalid")
        : !hasConfiguredCredentials && !passwordRequested
          ? t("mobile.settings.profile.credentialsRequired")
          : passwordRequested && credentialsPassword.length < 12
            ? t("mobile.settings.profile.passwordTooShort")
            : passwordRequested && credentialsPassword !== credentialsConfirmation
              ? t("mobile.settings.profile.passwordMismatch")
              : null
    : null;
  const credentialsCanSave =
    credentialsDirty &&
    credentialsEmailValid &&
    (passwordRequested
      ? credentialsPassword.length >= 12 && credentialsPassword === credentialsConfirmation
      : hasConfiguredCredentials);
  const avatarUrl = session.user.avatarUrl ? new URL(session.user.avatarUrl, session.apiUrl).toString() : null;

  async function perform(
    action: "name" | "photo" | "credentials" | "sign-out",
    operation: () => Promise<void>,
  ): Promise<void> {
    if (locked.current) return;
    locked.current = true;
    setPendingAction(action);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause, t("mobile.settings.profile.saveFailed")));
      void haptics.notification("error");
    } finally {
      locked.current = false;
      setPendingAction(null);
    }
  }

  async function saveName(): Promise<void> {
    if (!nameChanged || validatedName.error) return;
    await perform("name", async () => {
      await updateProfile({ name: validatedName.name });
      setDraftName(null);
      if (!credentialsDirty) setEditingInformation(false);
      Keyboard.dismiss();
      void haptics.notification("success");
    });
  }

  async function saveCredentials(): Promise<void> {
    if (!credentialsCanSave) return;
    await perform("credentials", async () => {
      await configureCredentials(credentialsEmail, credentialsPassword);
      setCredentialsEmail(normalizedCredentialsEmail);
      setCredentialsPassword("");
      setCredentialsConfirmation("");
      if (!nameChanged) setEditingInformation(false);
      Keyboard.dismiss();
      void haptics.notification("success");
    });
  }

  function toggleInformationEditing(): void {
    if (editingInformation && (nameChanged || credentialsDirty)) {
      Alert.alert(t("mobile.settings.profile.discardChangesTitle"), t("mobile.settings.profile.discardChangesBody"), [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("mobile.settings.profile.discardChanges"),
          style: "destructive",
          onPress: () => {
            setDraftName(null);
            setCredentialsEmail("");
            setCredentialsPassword("");
            setCredentialsConfirmation("");
            setError(null);
            setEditingInformation(false);
            Keyboard.dismiss();
          },
        },
      ]);
      return;
    }
    if (editingInformation) {
      setEditingInformation(false);
      return;
    }
    setCredentialsEmail(savedEmail);
    setCredentialsPassword("");
    setCredentialsConfirmation("");
    setEditingInformation(true);
  }

  async function choosePhoto(): Promise<void> {
    const photo = await pickAvatarPhoto("/settings/crop-photo");
    if (!photo) return;
    const avatar = { bytes: photo.bytes, mimeType: photo.mimeType };
    await updateProfile({ avatar });
    void haptics.notification("success");
  }

  async function removePhoto(): Promise<void> {
    await updateProfile({ avatar: null });
    void haptics.notification("success");
  }

  function editPhoto(): void {
    void haptics.impact("soft");
    if (!avatarUrl) {
      void perform("photo", choosePhoto);
      return;
    }
    Alert.alert(t("mobile.settings.profile.photo"), undefined, [
      { text: t("mobile.settings.profile.changePhoto"), onPress: () => void perform("photo", choosePhoto) },
      {
        text: t("mobile.settings.profile.removePhoto"),
        style: "destructive",
        onPress: () => void perform("photo", removePhoto),
      },
      { text: t("common.cancel"), style: "cancel" },
    ]);
  }

  return (
    <SheetScrollView
      className="bg-sheet"
      contentContainerClassName="gap-5 px-5 pb-safe-offset-5"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      <SheetSaveAction
        dirty={nameChanged || credentialsDirty}
        canSave={!busy && (credentialsDirty ? credentialsCanSave : nameChanged && !validatedName.error)}
        pending={pendingAction === "name" || pendingAction === "credentials"}
        label={t(credentialsDirty ? "mobile.settings.profile.saveCredentials" : "mobile.settings.profile.saveName")}
        onSave={() => void (credentialsDirty ? saveCredentials() : saveName())}
      />
      <View className="gap-6">
        <Pressable
          className="self-center"
          accessibilityRole="button"
          accessibilityLabel={
            avatarUrl ? t("mobile.settings.profile.editPhoto") : t("mobile.settings.profile.addPhoto")
          }
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={editPhoto}
        >
          <ProfileAvatar neutral name={savedName} imageUrl={avatarUrl} size={112} />
          <View className="absolute right-0 bottom-0 size-9 items-center justify-center rounded-full border-4 border-sheet bg-grouped">
            <Camera color={foreground} size={14} />
          </View>
        </Pressable>
        <SettingsSection>
          {!editingInformation ? (
            <SettingsRow>
              <View className="gap-1">
                <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                  {t("mobile.settings.profile.name")}
                </Typography.Paragraph>
                <Typography.Paragraph>{savedName}</Typography.Paragraph>
              </View>
            </SettingsRow>
          ) : (
            <SettingsRow>
              <SheetFormField
                label={t("mobile.settings.profile.name")}
                appearance="soft"
                placeholder={t("mobile.settings.profile.namePlaceholder")}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="done"
                value={name}
                editable={!busy}
                onChangeText={(value) => {
                  setDraftName(value);
                  setError(null);
                }}
                onSubmitEditing={() => void saveName()}
              />
            </SettingsRow>
          )}
          <SettingsRow
            accessibilityLabel={t(
              editingInformation
                ? "mobile.settings.profile.hideInformation"
                : "mobile.settings.profile.editInformation",
            )}
            disabled={busy}
            onPress={toggleInformationEditing}
            trailing={editingInformation ? <ChevronUp color={foreground} size={18} /> : undefined}
          >
            <Typography.Paragraph>
              {t(
                editingInformation
                  ? "mobile.settings.profile.hideInformation"
                  : "mobile.settings.profile.editInformation",
              )}
            </Typography.Paragraph>
          </SettingsRow>
        </SettingsSection>
      </View>
      {nameError || error ? (
        <Typography.Paragraph accessibilityRole="alert" className="text-danger-text">
          {nameError ?? error}
        </Typography.Paragraph>
      ) : null}
      {session.localOnly && session.sessionToken ? (
        <SettingsSection title={t("mobile.settings.profile.localIdentity")}>
          {editingInformation ? (
            <>
              <SettingsRow>
                <View className="w-full gap-3">
                  <SheetFormField
                    label={t("mobile.settings.profile.credentialsEmail")}
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!busy}
                    value={credentialsEmail}
                    onChangeText={(value) => {
                      setCredentialsEmail(value);
                      setError(null);
                    }}
                  />
                  <SheetFormField
                    label={t(
                      hasConfiguredCredentials
                        ? "mobile.settings.profile.credentialsNewPassword"
                        : "mobile.settings.profile.credentialsPassword",
                    )}
                    hint={hasConfiguredCredentials ? t("mobile.settings.profile.credentialsPasswordHint") : undefined}
                    secureTextEntry
                    maxLength={256}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!busy}
                    value={credentialsPassword}
                    onChangeText={(value) => {
                      setCredentialsPassword(value);
                      setError(null);
                    }}
                  />
                  <SheetFormField
                    label={t("mobile.settings.profile.credentialsConfirm")}
                    secureTextEntry
                    maxLength={256}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!busy}
                    value={credentialsConfirmation}
                    onChangeText={(value) => {
                      setCredentialsConfirmation(value);
                      setError(null);
                    }}
                  />
                </View>
              </SettingsRow>
              {credentialsError ? (
                <SettingsRow>
                  <Typography.Paragraph accessibilityRole="alert" className="text-danger-text">
                    {credentialsError}
                  </Typography.Paragraph>
                </SettingsRow>
              ) : null}
            </>
          ) : null}
          <SettingsRow
            disclosure={false}
            disabled={busy}
            onPress={() =>
              Alert.alert(
                t("mobile.settings.profile.localIdentityDisconnectTitle"),
                t("mobile.settings.profile.localIdentityDisconnectBody"),
                [
                  { text: t("common.cancel"), style: "cancel" },
                  {
                    text: t("mobile.settings.profile.localIdentityDisconnect"),
                    style: "destructive",
                    onPress: () => void perform("sign-out", signOut),
                  },
                ],
              )
            }
          >
            <Typography.Paragraph className="text-danger-text">
              {t("mobile.settings.profile.localIdentityDisconnect")}
            </Typography.Paragraph>
          </SettingsRow>
        </SettingsSection>
      ) : null}
      {!session.localOnly ? (
        <>
          <SettingsSection title={t("mobile.settings.profile.email")}>
            <SettingsRow>
              <Typography.Paragraph selectable className="text-grouped-secondary">
                {session.user.email}
              </Typography.Paragraph>
            </SettingsRow>
          </SettingsSection>
          <SettingsSection title={t("mobile.settings.profile.security")}>
            <SettingsRow disabled={busy} onPress={() => router.push("/settings/sessions")}>
              <Typography.Paragraph>{t("mobile.settings.profile.accountSessions")}</Typography.Paragraph>
            </SettingsRow>
          </SettingsSection>
          <SettingsSection>
            <SettingsRow
              disclosure={false}
              disabled={busy}
              onPress={() =>
                Alert.alert(t("mobile.settings.profile.signOutTitle"), t("mobile.settings.profile.signOutBody"), [
                  { text: t("common.cancel"), style: "cancel" },
                  {
                    text: t("mobile.settings.profile.signOut"),
                    style: "destructive",
                    onPress: () => void perform("sign-out", signOut),
                  },
                ])
              }
            >
              <Typography.Paragraph className="text-danger-text">
                {t("mobile.settings.profile.signOut")}
              </Typography.Paragraph>
            </SettingsRow>
          </SettingsSection>
        </>
      ) : null}
    </SheetScrollView>
  );
}
