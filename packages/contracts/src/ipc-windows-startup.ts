import { isBoolean, isDynamicRecord, isOneOf } from "./runtime-values";

export const WINDOWS_STARTUP_MODES = ["minimized", "shown"] as const;
export type WindowsStartupMode = (typeof WINDOWS_STARTUP_MODES)[number];

export interface WindowsStartupSettings {
  supported: boolean;
  launchAtLogin: boolean;
  startupMode: WindowsStartupMode;
}

export interface SetWindowsStartupSettingsInput {
  launchAtLogin: boolean;
  startupMode: WindowsStartupMode;
}

export function isWindowsStartupMode(value: unknown): value is WindowsStartupMode {
  return isOneOf(WINDOWS_STARTUP_MODES, value);
}

export function isSetWindowsStartupSettingsInput(value: unknown): value is SetWindowsStartupSettingsInput {
  return isDynamicRecord(value) && isBoolean(value.launchAtLogin) && isWindowsStartupMode(value.startupMode);
}

export function isWindowsStartupSettings(value: unknown): value is WindowsStartupSettings {
  return (
    isDynamicRecord(value) &&
    isBoolean(value.supported) &&
    isBoolean(value.launchAtLogin) &&
    isWindowsStartupMode(value.startupMode)
  );
}
