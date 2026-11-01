import { Image } from "expo-image";
import { Slider, Typography } from "heroui-native";
import { useState } from "react";
import { View } from "react-native";
import { UsageSegments } from "@/features/agents/components/usage-segments";
import {
  SettingsContent,
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "@/features/settings/components/settings-content";
import {
  deleteCustomThemeImage,
  pickCustomThemeImage,
  saveCustomTheme,
  useCustomTheme,
} from "@/features/settings/model/custom-theme";
import { useText } from "@/shared/lib/text";

export function ThemeSettingsScreen() {
  const { t } = useText();
  const theme = useCustomTheme();
  const [error, setError] = useState<string | null>(null);
  async function chooseImage() {
    if (theme.saving) return;
    setError(null);
    let imageUri: string | null = null;
    try {
      imageUri = await pickCustomThemeImage();
      if (!imageUri) return;
      await saveCustomTheme({ ...theme, mode: "custom", imageUri });
      if (theme.imageUri && theme.imageUri !== imageUri) await deleteCustomThemeImage(theme.imageUri);
    } catch {
      await deleteCustomThemeImage(imageUri).catch(() => undefined);
      setError(t("mobile.settings.theme.imageFailed"));
    }
  }

  async function removeImage() {
    if (theme.saving) return;
    const previous = theme.imageUri;
    try {
      await saveCustomTheme({ ...theme, imageUri: null });
      await deleteCustomThemeImage(previous);
    } catch {
      setError(t("mobile.settings.theme.saveFailed"));
    }
  }

  function saveRange(field: "blur" | "opacity", value: number | number[]) {
    const next = Array.isArray(value) ? value[0] : value;
    if (typeof next !== "number") return;
    void saveCustomTheme({ ...theme, [field]: next }).catch(() => setError(t("mobile.settings.theme.saveFailed")));
  }

  async function changeMode(mode: "dark" | "custom") {
    setError(null);
    try {
      await saveCustomTheme({ ...theme, mode });
    } catch {
      setError(t("mobile.settings.theme.saveFailed"));
    }
  }

  return (
    <SettingsContent>
      <SettingsSection title={t("mobile.settings.theme.title")} footer={t("mobile.settings.theme.footer")}>
        <View className="px-4 py-3">
          <UsageSegments
            options={[
              { value: "dark", label: t("mobile.settings.theme.dark") },
              { value: "custom", label: t("mobile.settings.theme.custom") },
            ]}
            value={theme.mode}
            onChange={(mode) => void changeMode(mode)}
          />
        </View>
      </SettingsSection>

      {theme.mode === "custom" ? (
        <SettingsSection title={t("mobile.settings.theme.background.title")}>
          <SettingsRow
            onPress={() => void chooseImage()}
            disabled={!theme.ready || theme.saving}
            disclosure={false}
            supportingText={t("mobile.settings.theme.background.imageDescription")}
          >
            <Typography.Paragraph type="body-sm">
              {theme.imageUri
                ? t("mobile.settings.theme.background.choose")
                : t("mobile.settings.theme.background.add")}
            </Typography.Paragraph>
          </SettingsRow>
          {theme.imageUri ? (
            <View className="gap-2 px-4 py-3">
              <Image
                source={{ uri: theme.imageUri }}
                contentFit="cover"
                blurRadius={theme.blur}
                style={{ width: "100%", height: 176, borderRadius: 14, opacity: theme.opacity / 100 }}
                accessibilityLabel={t("mobile.settings.theme.background.preview")}
              />
              <SettingsRow onPress={() => void removeImage()} disabled={theme.saving} disclosure={false}>
                <Typography.Paragraph type="body-sm" className="text-danger-text">
                  {t("mobile.settings.theme.background.remove")}
                </Typography.Paragraph>
              </SettingsRow>
            </View>
          ) : null}
          {theme.imageUri ? (
            <View className="gap-2 px-4 py-3">
              <View className="flex-row items-center justify-between">
                <Typography.Paragraph type="body-sm">
                  {t("mobile.settings.theme.background.blur", { value: theme.blur })}
                </Typography.Paragraph>
              </View>
              <Slider
                value={theme.blur}
                minValue={0}
                maxValue={24}
                step={1}
                isDisabled={!theme.ready || theme.saving}
                onChangeEnd={(value) => saveRange("blur", value)}
                aria-label={t("mobile.settings.theme.background.blurLabel")}
              >
                <Slider.Track className="h-3">
                  <Slider.Fill />
                  <Slider.Thumb />
                </Slider.Track>
              </Slider>
              <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                {t("mobile.settings.theme.background.blurDescription")}
              </Typography.Paragraph>
            </View>
          ) : null}
          {theme.imageUri ? (
            <View className="gap-2 px-4 py-3">
              <Typography.Paragraph type="body-sm">
                {t("mobile.settings.theme.background.opacity", { value: theme.opacity })}
              </Typography.Paragraph>
              <Slider
                value={theme.opacity}
                minValue={10}
                maxValue={100}
                step={1}
                isDisabled={!theme.ready || theme.saving}
                onChangeEnd={(value) => saveRange("opacity", value)}
                aria-label={t("mobile.settings.theme.background.opacityLabel")}
              >
                <Slider.Track className="h-3">
                  <Slider.Fill />
                  <Slider.Thumb />
                </Slider.Track>
              </Slider>
              <Typography.Paragraph type="body-xs" className="text-grouped-secondary">
                {t("mobile.settings.theme.background.opacityDescription")}
              </Typography.Paragraph>
            </View>
          ) : null}
        </SettingsSection>
      ) : null}
      {error ? <SettingsNote>{error}</SettingsNote> : null}
    </SettingsContent>
  );
}
