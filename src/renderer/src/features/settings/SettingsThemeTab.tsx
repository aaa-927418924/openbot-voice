import {
  Button,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  RadioGroup,
  SettingsSection,
  SliderField,
  toast,
} from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useI18n } from "../../i18n-context";
import { type DesktopThemeSettings, encodeDesktopThemeImage } from "./theme-settings";

export function SettingsThemeTab(props: {
  value: DesktopThemeSettings;
  onChange: (value: DesktopThemeSettings) => boolean;
}) {
  const i18n = useI18n();
  const [selectingImage, setSelectingImage] = createSignal(false);
  let imageInput: HTMLInputElement | undefined;

  const update = (patch: Partial<DesktopThemeSettings>) => {
    props.onChange({ ...props.value, ...patch });
  };

  async function selectImage(file: File | undefined): Promise<void> {
    if (!file || selectingImage()) return;
    setSelectingImage(true);
    try {
      const imageDataUrl = await encodeDesktopThemeImage(file);
      if (!props.onChange({ ...props.value, mode: "custom", imageDataUrl }))
        toast.error(i18n.t("settings.theme.saveFailed"));
    } catch {
      toast.error(i18n.t("settings.theme.imageFailed"));
    } finally {
      setSelectingImage(false);
      if (imageInput) imageInput.value = "";
    }
  }

  return (
    <div class="settings-theme-tab">
      <SettingsSection title={i18n.t("settings.theme.appearance.title")}>
        <ItemGroup class="settings-modal-card">
          <RadioGroup.Root
            class="settings-theme-segments"
            aria-label={i18n.t("settings.theme.appearance.title")}
            orientation="horizontal"
            value={props.value.mode}
            onChange={(value) => update({ mode: value === "custom" ? "custom" : "dark" })}
          >
            <For each={["dark", "custom"] as const}>
              {(mode) => (
                <RadioGroup.Item class="settings-theme-segment" value={mode}>
                  <RadioGroup.ItemInput />
                  <RadioGroup.ItemControl class="settings-theme-segment-control">
                    <RadioGroup.ItemLabel>{i18n.t(`settings.theme.${mode}`)}</RadioGroup.ItemLabel>
                  </RadioGroup.ItemControl>
                </RadioGroup.Item>
              )}
            </For>
          </RadioGroup.Root>
        </ItemGroup>
      </SettingsSection>

      <Show when={props.value.mode === "custom"}>
        <SettingsSection title={i18n.t("settings.theme.background.title")}>
          <ItemGroup class="settings-modal-card">
            <Item class="settings-modal-row">
              <ItemContent>
                <ItemTitle>{i18n.t("settings.theme.background.image")}</ItemTitle>
                <ItemDescription>{i18n.t("settings.theme.background.imageDescription")}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Input
                  ref={imageInput}
                  class="settings-theme-file-input"
                  type="file"
                  accept="image/*"
                  onChange={(event) => void selectImage(event.currentTarget.files?.[0])}
                />
                <Button variant="secondary" disabled={selectingImage()} onClick={() => imageInput?.click()}>
                  {selectingImage()
                    ? i18n.t("settings.theme.background.loading")
                    : i18n.t("settings.theme.background.choose")}
                </Button>
                <Show when={props.value.imageDataUrl}>
                  <Button variant="ghost" onClick={() => update({ imageDataUrl: null })}>
                    {i18n.t("settings.theme.background.remove")}
                  </Button>
                </Show>
              </ItemActions>
            </Item>

            <Show when={props.value.imageDataUrl}>
              {(image) => (
                <div
                  class="settings-theme-preview"
                  style={{ "background-image": `url("${image()}")` }}
                  role="img"
                  aria-label={i18n.t("settings.theme.background.preview")}
                />
              )}
            </Show>

            <SliderField
              class="settings-theme-slider-row"
              label={i18n.t("settings.theme.background.blurLabel")}
              description={i18n.t("settings.theme.background.blurDescription")}
              value={props.value.blur}
              minValue={0}
              maxValue={24}
              step={1}
              formatValue={(value) => `${value}px`}
              onChange={(blur) => update({ blur })}
            />

            <SliderField
              class="settings-theme-slider-row"
              label={i18n.t("settings.theme.background.opacityLabel")}
              description={i18n.t("settings.theme.background.opacityDescription")}
              value={props.value.opacity}
              minValue={10}
              maxValue={100}
              step={1}
              formatValue={(value) => `${value}%`}
              onChange={(opacity) => update({ opacity })}
            />
          </ItemGroup>
        </SettingsSection>
      </Show>
    </div>
  );
}
