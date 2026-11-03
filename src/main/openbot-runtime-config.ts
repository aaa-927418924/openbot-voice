import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LOCAL_TAILNET_API_PORT } from "./tailscale-network";

/** A second Linux host process that belongs to the self-hosted account server. */
export function isOpenBotCloudHost(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "linux" && environment.OPENBOT_CLOUD_HOST === "1";
}

/** The cloud host is headless by default, but can show its own GUI when explicitly requested. */
export function shouldStartOpenBotCloudHostHidden(environment: NodeJS.ProcessEnv = process.env): boolean {
  return isOpenBotCloudHost(environment) && environment.OPENBOT_CLOUD_HOST_SHOW_UI !== "1";
}

/** The Cloud host is the server itself, so its local-host switch must not be user-managed. */
export function supportsUserManagedLocalHost(localOnlyNetworking: boolean, cloudHostMode: boolean): boolean {
  return localOnlyNetworking && !cloudHostMode;
}

/** Keeps the portable agent/workspace tree separate from the Electron profile and from `~/OpenBot`. */
export function resolveOpenBotDataRoot(
  homePath = homedir(),
  configuredPath: string | undefined = process.env.OPENBOT_DATA_ROOT,
): string {
  const value = configuredPath?.trim();
  if (!value) return join(homePath, "OpenBot");
  if (!isAbsolute(value)) throw new Error("OPENBOT_DATA_ROOT must be an absolute path.");
  const root = resolve(value);
  const localRoot = resolve(homePath, "OpenBot");
  const overlaps = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  if (overlaps(localRoot, root) || overlaps(root, localRoot)) {
    throw new Error("OPENBOT_DATA_ROOT must be separate from the local OpenBot data root.");
  }
  return root;
}

export function readOpenBotCloudHostPort(environment: NodeJS.ProcessEnv = process.env): number {
  const value = environment.OPENBOT_TEAM_API_PORT?.trim();
  if (!value) return LOCAL_TAILNET_API_PORT;
  if (!/^\d{1,5}$/u.test(value)) throw new Error("OPENBOT_TEAM_API_PORT must be an integer from 1024 to 65535.");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("OPENBOT_TEAM_API_PORT must be an integer from 1024 to 65535.");
  }
  return port;
}
