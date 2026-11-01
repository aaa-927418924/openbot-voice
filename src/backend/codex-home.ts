import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The directory name of the dedicated Codex state inside OpenBot's userData. */
export const CODEX_HOME_DIR_NAME = "codex-home";

export interface CodexHomeOptions {
  /** Electron's userData path. The Codex SQLite state lives directly inside it. */
  userDataPath: string;
  /** Optional other OpenBot profile that owns the shared local Codex sign-in. */
  codexHomeUserDataPath?: string;
}

/**
 * Owns the locations of OpenBot's Codex sign-in and SQLite state. They normally share one
 * dedicated directory; a separate Cloud host can read the regular OpenBot sign-in while keeping
 * its provider database in its own profile. OpenBot never reads or writes the shared `~/.codex`.
 */
export class CodexHome {
  readonly #userDataPath: string;
  readonly #codexHomeUserDataPath: string;

  constructor(options: CodexHomeOptions) {
    this.#userDataPath = options.userDataPath;
    this.#codexHomeUserDataPath = options.codexHomeUserDataPath ?? options.userDataPath;
  }

  /** The dedicated Codex home directory. Not created until `ensure` runs. */
  get path(): string {
    return join(this.#codexHomeUserDataPath, CODEX_HOME_DIR_NAME);
  }

  /** The provider's SQLite files stay with this OpenBot profile. */
  get sqlitePath(): string {
    return join(this.#userDataPath, CODEX_HOME_DIR_NAME);
  }

  /** Creates both directories and returns the sign-in home. Throws instead of falling back. */
  ensure(): string {
    mkdirSync(this.path, { recursive: true, mode: 0o700 });
    mkdirSync(this.sqlitePath, { recursive: true, mode: 0o700 });
    return this.path;
  }

  /** The environment for a Codex child process, keeping its SQLite directory profile-local. */
  processEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    this.ensure();
    return codexProcessEnv(this.path, base, this.sqlitePath);
  }
}

/** Where a Codex process would keep state without an override: never used silently. */
export function legacyCodexHome(): string {
  return join(homedir(), ".codex");
}

/**
 * Returns the environment for a Codex child process. Without a home the base is returned
 * unchanged (tests and tools that predate the dedicated home). With a home, both directories are
 * created and `CODEX_SQLITE_HOME` defaults to the sign-in home unless a profile-local path is given.
 * A home that cannot be created throws and never falls back to {@link legacyCodexHome}.
 */
export function codexProcessEnv(
  codexHome: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
  sqliteHome: string | undefined = codexHome,
): NodeJS.ProcessEnv {
  if (codexHome === undefined) return base;
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (sqliteHome !== undefined) mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
  return { ...base, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome ?? codexHome };
}
