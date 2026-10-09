import type {
  SetWindowsStartupSettingsInput,
  WindowsStartupMode,
  WindowsStartupSettings,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";
import { RemoteWorkflowError, remoteDecode } from "./remote-service-effects";

export const WINDOWS_STARTUP_FLAG = "--openbot-start-minimized";
const DEFAULT_STARTUP_MODE: WindowsStartupMode = "shown";
const STARTUP_PREFERENCE_VERSION = 1;

export function isWindowsStartupMinimized(platform: NodeJS.Platform, argv: readonly string[]): boolean {
  return platform === "win32" && argv.includes(WINDOWS_STARTUP_FLAG);
}

export function windowsStartupArguments(mode: WindowsStartupMode): string[] {
  return mode === "minimized" ? [WINDOWS_STARTUP_FLAG] : [];
}

function decodeStartupMode(value: unknown): WindowsStartupMode {
  if (!isDynamicRecord(value) || value.version !== STARTUP_PREFERENCE_VERSION) return DEFAULT_STARTUP_MODE;
  return value.startupMode === "minimized" || value.startupMode === "shown" ? value.startupMode : DEFAULT_STARTUP_MODE;
}

function readStartupMode(path: string): Effect.Effect<WindowsStartupMode, PreferenceFileFailure> {
  return readPreferenceFile(path, decodeStartupMode).pipe(
    Effect.catch((failure) =>
      isMissingFileError(failure.cause) || failure.cause instanceof SyntaxError
        ? Effect.succeed(DEFAULT_STARTUP_MODE)
        : Effect.fail(failure),
    ),
  );
}

function writeStartupMode(path: string, startupMode: WindowsStartupMode) {
  return writePreferenceFile(path, { version: STARTUP_PREFERENCE_VERSION, startupMode }, { createDirectory: true });
}

export interface WindowsLoginItemSettingsOptions {
  path: string;
  args: string[];
}

export interface WindowsStartupControllerOptions {
  supported: boolean;
  preferencePath: string;
  executablePath: string;
  getLoginItemSettings: (options: WindowsLoginItemSettingsOptions) => { openAtLogin: boolean };
  setLoginItemSettings: (options: WindowsLoginItemSettingsOptions & { openAtLogin: boolean }) => void;
}

export interface WindowsStartupController {
  get: () => Effect.Effect<WindowsStartupSettings, RemoteWorkflowError>;
  set: (input: SetWindowsStartupSettingsInput) => Effect.Effect<WindowsStartupSettings, RemoteWorkflowError>;
}

export function createWindowsStartupController({
  supported,
  preferencePath,
  executablePath,
  getLoginItemSettings,
  setLoginItemSettings,
}: WindowsStartupControllerOptions): WindowsStartupController {
  function get(): Effect.Effect<WindowsStartupSettings, RemoteWorkflowError> {
    const mode = Effect.mapError(
      readStartupMode(preferencePath),
      (failure) => new RemoteWorkflowError({ cause: failure.cause }),
    );
    return mode.pipe(
      Effect.flatMap((startupMode) => {
        if (!supported) {
          return Effect.succeed<WindowsStartupSettings>({ supported: false, launchAtLogin: false, startupMode });
        }
        return remoteDecode<WindowsStartupSettings>(() => ({
          supported: true,
          launchAtLogin: getLoginItemSettings({ path: executablePath, args: windowsStartupArguments(startupMode) })
            .openAtLogin,
          startupMode,
        }));
      }),
    );
  }

  function set(input: SetWindowsStartupSettingsInput): Effect.Effect<WindowsStartupSettings, RemoteWorkflowError> {
    if (!supported) {
      return remoteDecode(() => {
        throw new Error("Windows startup settings are unavailable in this build.");
      });
    }
    const mode = Effect.mapError(
      readStartupMode(preferencePath),
      (failure) => new RemoteWorkflowError({ cause: failure.cause }),
    );
    return mode.pipe(
      Effect.flatMap((previousMode) =>
        writeStartupMode(preferencePath, input.startupMode).pipe(
          Effect.mapError((failure) => new RemoteWorkflowError({ cause: failure.cause })),
          Effect.andThen(
            remoteDecode(() =>
              setLoginItemSettings({
                openAtLogin: input.launchAtLogin,
                path: executablePath,
                args: windowsStartupArguments(input.startupMode),
              }),
            ).pipe(
              Effect.catch((error) =>
                writeStartupMode(preferencePath, previousMode).pipe(
                  Effect.mapError((failure) => new RemoteWorkflowError({ cause: failure.cause })),
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            ),
          ),
          Effect.andThen(get()),
        ),
      ),
    );
  }

  return { get, set };
}
