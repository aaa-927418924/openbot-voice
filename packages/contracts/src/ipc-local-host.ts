export interface LocalHostSettings {
  readonly supported: boolean;
  readonly enabled: boolean;
}

export interface SetLocalHostSettingsInput {
  readonly enabled: boolean;
}

export function isLocalHostSettings(value: unknown): value is LocalHostSettings {
  return (
    value !== null &&
    typeof value === "object" &&
    "supported" in value &&
    typeof value.supported === "boolean" &&
    "enabled" in value &&
    typeof value.enabled === "boolean"
  );
}

export function isSetLocalHostSettingsInput(value: unknown): value is SetLocalHostSettingsInput {
  return value !== null && typeof value === "object" && "enabled" in value && typeof value.enabled === "boolean";
}
