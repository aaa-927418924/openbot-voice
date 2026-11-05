import { basename } from "node:path";
import { remoteCommandRequiresAutoReview } from "./remote-device-command-risk";

export type LocalCommandReview =
  | { allowed: true; rule: "read_only_powershell_listing" | "read_only_system_command" }
  | { allowed: false; reason: "high_risk" | "unreviewable_command" };

const SAFE_LINUX_COMMANDS = new Set(["ls", "du", "df", "stat", "pwd", "whoami", "hostname", "uname", "date"]);
const SAFE_WINDOWS_COMMANDS = new Set(["whoami", "hostname", "where", "systeminfo"]);
const SAFE_PATH_CHARACTERS = /^[A-Za-z0-9_./\\:~$ -]+$/u;

/** Applies a deterministic target-local review. It does not call a model or send command text anywhere. */
export function reviewRemoteCommandLocally(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): LocalCommandReview {
  const executableName = basename(executable)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  if (isPowerShell(executableName)) {
    return isReadOnlyPowerShellListing(args)
      ? { allowed: true, rule: "read_only_powershell_listing" }
      : { allowed: false, reason: "unreviewable_command" };
  }
  if (remoteCommandRequiresAutoReview(executable, args)) return { allowed: false, reason: "high_risk" };

  const safeCommands = platform === "win32" ? SAFE_WINDOWS_COMMANDS : SAFE_LINUX_COMMANDS;
  if (!safeCommands.has(executableName) || !isSafeSystemCommand(executableName, args, platform)) {
    return { allowed: false, reason: "unreviewable_command" };
  }
  return { allowed: true, rule: "read_only_system_command" };
}

function isPowerShell(name: string): boolean {
  return name === "powershell" || name === "pwsh";
}

function isReadOnlyPowerShellListing(args: readonly string[]): boolean {
  const commandIndex = args.findIndex((argument) => argument.toLowerCase() === "-command");
  if (commandIndex < 0 || commandIndex !== args.length - 2) return false;
  const startupFlags = args.slice(0, commandIndex).map((argument) => argument.toLowerCase());
  if (!startupFlags.includes("-noprofile") || !startupFlags.includes("-noninteractive")) return false;
  if (
    args.some(
      (argument, index) =>
        index !== commandIndex &&
        index !== commandIndex + 1 &&
        !["-noprofile", "-noninteractive", "-nologo"].includes(argument.toLowerCase()),
    )
  ) {
    return false;
  }
  const script = args.at(-1);
  if (!script || script.length > 4_096) return false;
  const stages = splitPipeline(script);
  if (!stages || stages.length < 1 || stages.length > 4) return false;
  const first = tokenize(stages[0] ?? "");
  if (!first || !isChildItemStage(first)) return false;
  return stages.slice(1).every((stage) => {
    const tokens = tokenize(stage);
    return Boolean(tokens && (isSortStage(tokens) || isSelectStage(tokens) || isMeasureStage(tokens)));
  });
}

function splitPipeline(script: string): string[] | null {
  const stages: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (
      character === "`" ||
      character === "\n" ||
      character === "\r" ||
      character === ";" ||
      character === "&" ||
      character === ">" ||
      character === "<" ||
      character === "{" ||
      character === "}" ||
      character === "(" ||
      character === ")"
    ) {
      return null;
    }
    if (quote) {
      if (character === quote) {
        // Doubled single quotes are PowerShell escapes and are not needed for a safe path here.
        if (quote === "'" && script[index + 1] === "'") return null;
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "|") {
      const stage = script.slice(start, index).trim();
      if (!stage) return null;
      stages.push(stage);
      start = index + 1;
    }
  }
  if (quote) return null;
  const last = script.slice(start).trim();
  if (!last) return null;
  stages.push(last);
  return stages;
}

function tokenize(stage: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let quoted = false;
  const flush = () => {
    if (token || quoted) tokens.push(token);
    token = "";
    quoted = false;
  };
  for (const character of stage) {
    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      if (character === "'" || character === '"') return null;
      token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      if (token || quoted) return null;
      quote = character;
      quoted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if ("`;&><{}()".includes(character)) return null;
    token += character;
  }
  if (quote) return null;
  flush();
  return tokens.length ? tokens : null;
}

function isChildItemStage(tokens: readonly string[]): boolean {
  const command = tokens[0]?.toLowerCase();
  if (command !== "get-childitem" && command !== "gci" && command !== "ls" && command !== "dir") return false;
  let pathSeen = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index]?.toLowerCase();
    if (option === "-path" || option === "-literalpath") {
      const path = tokens[++index];
      if (pathSeen || !path || !isSafeListingPath(path)) return false;
      pathSeen = true;
      continue;
    }
    if (["-file", "-directory", "-recurse", "-force"].includes(option ?? "")) continue;
    if (option === "-erroraction") {
      const action = tokens[++index]?.toLowerCase();
      if (action !== "silentlycontinue" && action !== "continue" && action !== "stop") return false;
      continue;
    }
    return false;
  }
  return true;
}

function isSafeListingPath(value: string): boolean {
  if (value.length === 0 || value.length > 1_024 || !SAFE_PATH_CHARACTERS.test(value)) return false;
  if (
    value
      .replaceAll("\\", "/")
      .split("/")
      .some((segment) => segment === "..")
  )
    return false;
  return (
    /^\$env:(?:USERPROFILE|HOME)(?:[\\/][A-Za-z0-9_. -]+)*$/iu.test(value) ||
    /^[A-Za-z]:[\\/][A-Za-z0-9_. -]+(?:[\\/][A-Za-z0-9_. -]+)*$/u.test(value) ||
    /^~(?:[\\/][A-Za-z0-9_. -]+)*$/u.test(value) ||
    /^(?:\.|[A-Za-z0-9_ -][A-Za-z0-9_. -]*)(?:[\\/][A-Za-z0-9_. -]+)*$/u.test(value)
  );
}

function isSortStage(tokens: readonly string[]): boolean {
  if (tokens[0]?.toLowerCase() !== "sort-object") return false;
  const values = tokens.slice(1).map((token) => token.toLowerCase());
  const properties = new Set(["length", "name", "fullname", "lastwritetime"]);
  if (values[0] === "-property") values.shift();
  if (values[0]?.startsWith("-")) return false;
  if (!properties.has(values.shift() ?? "")) return false;
  if (values.length === 0) return true;
  return values.length === 1 && (values[0] === "-descending" || values[0] === "-ascending");
}

function isSelectStage(tokens: readonly string[]): boolean {
  if (tokens[0]?.toLowerCase() !== "select-object") return false;
  let firstCount: number | null = null;
  let propertyToken: string | null = null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]?.toLowerCase();
    if (token === "-first") {
      const count = Number(tokens[++index]);
      if (firstCount !== null || !Number.isSafeInteger(count) || count < 1 || count > 1_000) return false;
      firstCount = count;
    } else if (token && !token.startsWith("-") && propertyToken === null) {
      propertyToken = token;
    } else {
      return false;
    }
  }
  const properties = propertyToken?.split(",");
  const allowed = new Set(["name", "fullname", "length", "lastwritetime", "directoryname", "mode"]);
  return Boolean(properties?.length && properties.every((property) => allowed.has(property)));
}

function isMeasureStage(tokens: readonly string[]): boolean {
  if (tokens[0]?.toLowerCase() !== "measure-object") return false;
  const allowedProperties = new Set(["-sum", "-minimum", "-maximum", "-average"]);
  let propertySeen = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index]?.toLowerCase();
    if (option === "-property") {
      const property = tokens[++index]?.toLowerCase();
      if (propertySeen || property !== "length") return false;
      propertySeen = true;
    } else if (!allowedProperties.has(option ?? "")) {
      return false;
    }
  }
  return true;
}

function isSafeSystemCommand(name: string, args: readonly string[], platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    if (name === "whoami" || name === "hostname") return args.length === 0;
    if (name === "where") return args.length > 0 && args.every((argument) => SAFE_PATH_CHARACTERS.test(argument));
    return name === "systeminfo" && args.length === 0;
  }

  if (["pwd", "whoami", "hostname", "date"].includes(name)) return args.length === 0;
  if (name === "uname") return args.length <= 1 && (args.length === 0 || args[0] === "-a");
  if (name === "df") return args.every((argument) => ["-h", "-T", "-P"].includes(argument));
  if (name === "stat") return args.length > 0 && args.every(isSafeReadOnlyPathArgument);
  if (name === "ls") {
    return args.every(
      (argument) =>
        ["-a", "-l", "-h", "-A", "-la", "-lh", "-lah", "-al", "-alh", "--all", "--human-readable", "--"].includes(
          argument,
        ) || isSafeReadOnlyPathArgument(argument),
    );
  }
  if (name === "du") {
    return args.every(
      (argument) =>
        ["-a", "-s", "-h", "-ah", "-sh", "-hs", "--max-depth=1", "--max-depth=2", "--"].includes(argument) ||
        isSafeReadOnlyPathArgument(argument),
    );
  }
  return false;
}

function isSafeReadOnlyPathArgument(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && SAFE_PATH_CHARACTERS.test(value) && !value.startsWith("-");
}
