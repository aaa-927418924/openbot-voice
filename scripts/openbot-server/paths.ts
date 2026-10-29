import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function openBotUserDataDirectory(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = environment.OPENBOT_SERVER_USER_DATA?.trim();
  if (override) return resolve(override);
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  return join(configHome ? resolve(configHome) : join(home, ".config"), "OpenBot");
}

export function runtimeDirectory(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = environment.OPENBOT_SERVER_RUNTIME_DIR?.trim();
  if (override) return resolve(override);
  const runtime = environment.XDG_RUNTIME_DIR?.trim();
  if (runtime?.startsWith("/")) return join(resolve(runtime), "openbot-server");
  const cacheHome = environment.XDG_CACHE_HOME?.trim();
  return join(cacheHome ? resolve(cacheHome) : join(home, ".cache"), "openbot-server");
}
