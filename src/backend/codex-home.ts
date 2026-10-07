import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The directory name of the dedicated Codex state inside OpenBot's userData. */
export const CODEX_HOME_DIR_NAME = "codex-home";

export interface CodexHomeOptions {
  /** Electron's userData path. The dedicated Codex state lives directly inside it. */
  userDataPath: string;
}

/**
 * Owns the location of OpenBot's dedicated Codex state. Every Codex process OpenBot starts
 * uses this directory through `CODEX_HOME` and `CODEX_SQLITE_HOME`, so the fork never reads
 * or writes the shared `~/.codex`. It never falls back to that directory: when the dedicated
 * home cannot be created, `ensure` and `codexProcessEnv` throw.
 */
export class CodexHome {
  readonly #userDataPath: string;

  constructor(options: CodexHomeOptions) {
    this.#userDataPath = options.userDataPath;
  }

  /** The dedicated Codex home directory. Not created until `ensure` runs. */
  get path(): string {
    return join(this.#userDataPath, CODEX_HOME_DIR_NAME);
  }

  /** Creates the directory and returns it. Throws instead of falling back. */
  ensure(): string {
    mkdirSync(this.path, { recursive: true, mode: 0o700 });
    return this.path;
  }

  /** The environment for a Codex child process: both Codex variables point at the ensured home. */
  processEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return codexProcessEnv(this.ensure(), base);
  }
}

/** Where a Codex process would keep state without an override: never used silently. */
export function legacyCodexHome(): string {
  return join(homedir(), ".codex");
}

/**
 * Returns the environment for a Codex child process. Without a home the base is returned
 * unchanged (tests and tools that predate the dedicated home). With a home the directory is
 * created and both Codex variables point at it; a home that cannot be created throws and
 * never falls back to {@link legacyCodexHome}.
 */
export function codexProcessEnv(
  codexHome: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (codexHome === undefined) return base;
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  return { ...base, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome };
}
