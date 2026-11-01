import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Picks a private source-snapshot directory that cannot be nested in either tree being copied.
 * Prefer a sibling of Electron's userData directory; if that would fall under the workspace,
 * fall back to the system temp directory and still enforce the same containment rule.
 */
export function serverMigrationSourceStagingRoot(
  userDataRoot: string,
  openBotRoot: string,
  tempRoot = tmpdir(),
): string {
  if (!isAbsolute(userDataRoot) || !isAbsolute(openBotRoot) || !isAbsolute(tempRoot)) {
    throw new Error("Server migration source paths must be absolute.");
  }

  const userData = resolve(userDataRoot);
  const workspace = resolve(openBotRoot);
  const candidates = [
    join(dirname(userData), `.${basename(userData)}-server-migration-source-staging`),
    join(resolve(tempRoot), "openbot-server-migration-source-staging"),
  ];
  const destination = candidates.find(
    (candidate) => !pathsOverlap(resolve(candidate), userData) && !pathsOverlap(resolve(candidate), workspace),
  );
  if (!destination) {
    throw new Error("Cannot find a server migration staging directory outside the source data roots.");
  }
  return destination;
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function containsPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
