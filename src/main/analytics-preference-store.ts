import type { AnalyticsPreference } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

const DEFAULT_PREFERENCE: AnalyticsPreference = { enabled: true };

/** Product analytics are disabled by policy in the Windows desktop app. */
export function analyticsEnabledForPlatform(enabled: boolean, platform: NodeJS.Platform = process.platform): boolean {
  return enabled && platform !== "win32";
}

export const readAnalyticsPreference = Effect.fn("readAnalyticsPreference")((path: string) =>
  readPreferenceFile(path, (parsed): AnalyticsPreference => {
    if (!isDynamicRecord(parsed) || parsed.version !== 1 || !isBoolean(parsed.enabled)) {
      return { enabled: false };
    }
    return { enabled: parsed.enabled };
  }).pipe(
    Effect.catch((failure) => {
      const error = failure.cause;
      if (isMissingFileError(error)) return Effect.succeed({ ...DEFAULT_PREFERENCE });
      if (error instanceof SyntaxError) return Effect.succeed({ enabled: false });
      return Effect.fail(failure);
    }),
  ),
);

export function writeAnalyticsPreference(
  path: string,
  enabled: boolean,
): Effect.Effect<AnalyticsPreference, PreferenceFileFailure> {
  return Effect.gen(function* () {
    const preference = { enabled };
    yield* writePreferenceFile(path, { version: 1, enabled });
    return preference;
  });
}
