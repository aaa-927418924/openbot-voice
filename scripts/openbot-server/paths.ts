import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export function openBotUserDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const path = platform === "win32" ? win32 : posix;
  const override = environment.OPENBOT_SERVER_USER_DATA?.trim();
  if (override) return path.resolve(override);
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  if (configHome) return path.join(path.resolve(configHome), "OpenBot");
  if (platform === "win32") {
    const appData = environment.APPDATA?.trim();
    return path.join(appData ? path.resolve(appData) : path.join(home, "AppData", "Roaming"), "OpenBot");
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "OpenBot");
  return path.join(home, ".config", "OpenBot");
}

export function runtimeDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const path = platform === "win32" ? win32 : posix;
  const override = environment.OPENBOT_SERVER_RUNTIME_DIR?.trim();
  if (override) return path.resolve(override);
  const runtime = environment.XDG_RUNTIME_DIR?.trim();
  if (runtime?.startsWith("/")) return path.join(path.resolve(runtime), "openbot-server");
  const cacheHome = environment.XDG_CACHE_HOME?.trim();
  if (cacheHome) return path.join(path.resolve(cacheHome), "openbot-server");
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim();
    return path.join(localAppData ? path.resolve(localAppData) : home, "OpenBot", "Cache", "openbot-server");
  }
  if (platform === "darwin") return path.join(home, "Library", "Caches", "OpenBot", "openbot-server");
  return path.join(home, ".cache", "openbot-server");
}
