import { basename } from "node:path";

/** Blocks known high-risk operations before the target starts a process. */
export function remoteCommandRequiresAutoReview(executable: string, args: readonly string[]): boolean {
  const command = [executable, ...args].join(" ").toLowerCase().replaceAll("\\", "/").replace(/\s+/gu, " ");
  const executableName = basename(executable)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  const normalizedArgs = args.map((argument) => argument.trim().toLowerCase());
  const codeRunners = new Set([
    "bash",
    "sh",
    "zsh",
    "fish",
    "cmd",
    "powershell",
    "pwsh",
    "python",
    "python2",
    "python3",
    "node",
    "bun",
    "ruby",
    "perl",
    "php",
    "lua",
    "awk",
    "gawk",
    "mawk",
    "wscript",
    "cscript",
    "npx",
  ]);
  const isCodeRunner =
    codeRunners.has(executableName) || /^python\d*(?:\.\d+)*$/u.test(executableName) || executableName === "pythonw";
  // A script runner can turn nearly any argument into code. Only permit its harmless identity
  // options; filenames and inline-evaluation switches are blocked without trying to parse a script.
  const informationalOptions = new Set(["--help", "-h", "--version", "-version", "-v", "/?", "-?"]);
  if (isCodeRunner && !(normalizedArgs.length === 1 && informationalOptions.has(normalizedArgs[0] ?? ""))) return true;
  if (
    ["env", "nohup", "timeout", "nice", "setsid", "xargs", "busybox"].includes(executableName) &&
    !(normalizedArgs.length === 1 && informationalOptions.has(normalizedArgs[0] ?? ""))
  ) {
    return true;
  }
  if (
    executableName === "git" &&
    (args.some((argument) => argument === "-c" || /^-c.+/u.test(argument) || argument === "--config-env") ||
      normalizedArgs.some((argument) => argument.startsWith("--exec-path")))
  ) {
    return true;
  }
  if (executableName === "git" && normalizedArgs[0] === "config") {
    const readOnlyConfigOptions = new Set([
      "--get",
      "--get-all",
      "--get-regexp",
      "--get-urlmatch",
      "--list",
      "-l",
      "--show-origin",
      "--show-scope",
    ]);
    if (!readOnlyConfigOptions.has(normalizedArgs[1] ?? "") && normalizedArgs.length > 2) return true;
  }
  if (
    ["npm", "npx", "pnpm", "yarn", "pip", "pip3", "gem", "cargo", "make", "gmake", "msbuild"].includes(
      executableName,
    ) &&
    normalizedArgs.some((argument) => ["run", "exec", "install", "add", "build", "test"].includes(argument))
  ) {
    return true;
  }
  if (
    [
      "ssh",
      "scp",
      "sftp",
      "plink",
      "pscp",
      "wsl",
      "docker",
      "podman",
      "kubectl",
      "psexec",
      "winrs",
      "rundll32",
      "regsvr32",
      "mshta",
    ].includes(executableName)
  ) {
    return true;
  }
  if (
    executableName === "rsync" &&
    normalizedArgs.some(
      (argument) =>
        argument === "--remove-source-files" ||
        argument === "--delete" ||
        argument.startsWith("--delete-") ||
        argument.startsWith("--delete="),
    )
  ) {
    return true;
  }
  if (
    executableName === "robocopy" &&
    normalizedArgs.some((argument) => ["/mir", "/purge", "/mov", "/move"].includes(argument))
  ) {
    return true;
  }
  if (executableName === "rclone" && normalizedArgs[0] === "sync") return true;
  if (
    executableName === "aws" &&
    normalizedArgs[0] === "s3" &&
    normalizedArgs[1] === "sync" &&
    normalizedArgs.includes("--delete")
  ) {
    return true;
  }
  const patterns = [
    /\b(rm|unlink|del|erase|remove-item|rmdir|rd|shred|truncate)\b/u,
    /\bgit\s+(?:clean\b|reset\s+--hard\b|checkout\s+--(?:\s|$)|restore\b|rm\b)/u,
    /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?\b|--delete\b)/u,
    /\b(mkfs(?:\.[a-z0-9]+)?|wipefs|diskpart|format-volume|format\s+[a-z]:|fdisk|parted)\b/u,
    /\bdd\s+[^\n]*\bof=/u,
    /\b(shutdown|reboot|poweroff|stop-computer|restart-computer)\b/u,
    /\b(reg\s+delete|regedit\s+\/s|takeown\b|icacls\b[^\n]*\/reset)\b/u,
    /\b(chmod|chown)\s+-(?:[^ ]*R|[^ ]*r)\b/u,
    /\b(sudo|runas)\b/u,
    /\b(taskkill|kill|killall|pkill)\b/u,
    /\bfind\b[^\n]*\s(?:-delete|-exec(?:dir)?)\b/u,
    /\b(systemctl|service|sc)\b[^\n]*\b(stop|disable|mask|restart|kill|delete|config)\b/u,
  ];
  return patterns.some((pattern) => pattern.test(command));
}
