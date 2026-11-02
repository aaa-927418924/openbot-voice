import { z } from "zod";

export type DesktopThemeSettings = {
  mode: "dark" | "custom";
  imageDataUrl: string | null;
  blur: number;
  opacity: number;
  accentColor: string;
};

const STORAGE_KEY = "openbot.desktop.theme.v1";
const MAX_IMAGE_DATA_URL_LENGTH = 1_900_000;
export const DEFAULT_DESKTOP_THEME: DesktopThemeSettings = {
  mode: "dark",
  imageDataUrl: null,
  blur: 8,
  opacity: 72,
  accentColor: "#007cf7",
};

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const storedThemeSchema = z.object({
  mode: z.enum(["dark", "custom"]).optional(),
  imageDataUrl: z.string().max(MAX_IMAGE_DATA_URL_LENGTH).nullable().optional(),
  blur: z.number().finite().optional(),
  opacity: z.number().finite().optional(),
  accentColor: z
    .string()
    .regex(/^#[\da-f]{6}$/iu)
    .optional(),
});

export function loadDesktopThemeSettings(): DesktopThemeSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DESKTOP_THEME;
    const parsed = storedThemeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return DEFAULT_DESKTOP_THEME;
    const saved = parsed.data;
    const imageDataUrl =
      typeof saved.imageDataUrl === "string" && /^data:image\/(?:jpeg|png|webp);base64,/u.test(saved.imageDataUrl)
        ? saved.imageDataUrl
        : null;
    return {
      mode: saved.mode === "custom" ? "custom" : "dark",
      imageDataUrl,
      blur: bounded(saved.blur, 0, 24, DEFAULT_DESKTOP_THEME.blur),
      opacity: bounded(saved.opacity, 10, 100, DEFAULT_DESKTOP_THEME.opacity),
      accentColor: saved.accentColor ?? DEFAULT_DESKTOP_THEME.accentColor,
    };
  } catch {
    return DEFAULT_DESKTOP_THEME;
  }
}

export function saveDesktopThemeSettings(value: DesktopThemeSettings): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Resize the selected local image before it enters localStorage; it is never sent to a server. */
export async function encodeDesktopThemeImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("not-image");
  const bitmap = await createImageBitmap(file);
  try {
    for (const maxDimension of [1600, 1280, 1024]) {
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-unavailable");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.8, 0.68, 0.56]) {
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob) continue;
        const encoded = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject());
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        if (encoded.length <= MAX_IMAGE_DATA_URL_LENGTH) return encoded;
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("image-too-large");
}
