import * as Crypto from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";
import { create } from "zustand";

export type MobileThemeSettings = {
  mode: "dark" | "custom";
  imageUri: string | null;
  blur: number;
  opacity: number;
};

type ThemeState = MobileThemeSettings & { ready: boolean; saving: boolean };

const STORAGE_KEY = "openbot.mobile.theme.v1";
const defaults: MobileThemeSettings = { mode: "dark", imageUri: null, blur: 8, opacity: 72 };

export const useCustomTheme = create<ThemeState>(() => ({ ...defaults, ready: false, saving: false }));
let themeWriteTail: Promise<void> = Promise.resolve();
let pendingThemeWrites = 0;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const storedThemeSchema = z.object({
  mode: z.enum(["dark", "custom"]).optional(),
  imageUri: z.string().nullable().optional(),
  blur: z.number().finite().optional(),
  opacity: z.number().finite().optional(),
});

export async function loadCustomTheme(): Promise<void> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (raw) {
      const parsed = storedThemeSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        const saved = parsed.data;
        useCustomTheme.setState({
          ...defaults,
          mode: saved.mode === "custom" ? "custom" : "dark",
          imageUri: saved.imageUri ?? null,
          blur: clamp(saved.blur, 0, 24, defaults.blur),
          opacity: clamp(saved.opacity, 10, 100, defaults.opacity),
        });
      }
    }
  } finally {
    useCustomTheme.setState({ ready: true });
  }
}

export async function saveCustomTheme(value: MobileThemeSettings): Promise<void> {
  if (!useCustomTheme.getState().ready) throw new Error("The theme has not loaded yet.");
  pendingThemeWrites += 1;
  useCustomTheme.setState({ saving: true });
  const write = themeWriteTail.then(async () => {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(value));
    useCustomTheme.setState({ ...value });
  });
  themeWriteTail = write.then(
    () => undefined,
    () => undefined,
  );
  try {
    await write;
  } finally {
    pendingThemeWrites -= 1;
    useCustomTheme.setState({ saving: pendingThemeWrites > 0 });
  }
}

export async function pickCustomThemeImage(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"] });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) throw new Error("No image was selected.");
  const original = await ImageManipulator.manipulate(asset.uri).renderAsync();
  const resized = await ImageManipulator.manipulate(original)
    .resize({ width: Math.min(1920, original.width) })
    .renderAsync();
  const saved = await resized.saveAsync({ format: SaveFormat.JPEG, compress: 0.82 });
  const destination = new File(Paths.document, `openbot-theme-${Crypto.randomUUID()}.jpg`);
  const sourceFile = new File(saved.uri);
  await sourceFile.copy(destination);
  if (sourceFile.exists) sourceFile.delete();
  return destination.uri;
}

export async function deleteCustomThemeImage(uri: string | null): Promise<void> {
  if (!uri) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}
