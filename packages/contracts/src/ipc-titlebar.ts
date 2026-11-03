import { isDynamicRecord, isString } from "./runtime-values";

export interface SetTitleBarOverlayThemeInput {
  readonly color: string;
  readonly symbolColor: string;
}

export type MainWindowControlAction = "minimize" | "toggle-maximize" | "close";

export function isMainWindowControlAction(value: unknown): value is MainWindowControlAction {
  return value === "minimize" || value === "toggle-maximize" || value === "close";
}

const TITLEBAR_COLOR =
  /^(?:#[\da-f]{6}(?:[\da-f]{2})?|rgba\(\s*(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*\))$/i;

export function isSetTitleBarOverlayThemeInput(value: unknown): value is SetTitleBarOverlayThemeInput {
  return (
    isDynamicRecord(value) &&
    isString(value.color) &&
    TITLEBAR_COLOR.test(value.color) &&
    isString(value.symbolColor) &&
    TITLEBAR_COLOR.test(value.symbolColor)
  );
}
