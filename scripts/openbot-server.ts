import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveLocale, translateFor } from "@openbot/i18n";
import { Effect } from "effect";
import { defaultLocalProfileName, LocalProfileStore } from "../src/main/local-profile-store";
import { SelfHostedAccountServerDirectory } from "../src/main/self-hosted-account-server-directory";
import { SELF_HOSTED_IDENTITY_API_PORT, SelfHostedIdentityApiServer } from "../src/main/self-hosted-identity-api";
import type { LocalProfileBootstrap } from "../src/main/self-hosted-identity-authority";
import { SelfHostedIdentityAuthority } from "../src/main/self-hosted-identity-authority";
import { tailscaleAddresses } from "../src/main/tailscale-network";
import { installedOpenBotExecutable, installUserService, removeUserService } from "./openbot-server/autostart";
import { assertTcpPortAvailable } from "./openbot-server/identity-api-port-guard";
import { openBotUserDataDirectory, runtimeDirectory } from "./openbot-server/paths";
import {
  type OpenBotServerStatus,
  readServerStatus,
  statusFilePath,
  writeServerStatus,
} from "./openbot-server/status-file";
import { createHostMetricsSampler } from "./openbot-server/system-metrics";

const execFileAsync = promisify(execFile);
const locale = resolveLocale("system", process.env.LANG ?? "en");
const t = translateFor(locale);
const cliDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(cliDirectory, "..");
const userDataDirectory = openBotUserDataDirectory();
const runtimeRoot = runtimeDirectory();
const statusPath = statusFilePath(runtimeRoot);
const identityPath = resolve(userDataDirectory, "self-hosted-identity.json");
const profilePath = resolve(userDataDirectory, "local-profile.json");
const statusIntervalMs = 3_000;

function bootstrapProfile(profile: LocalProfileStore): LocalProfileBootstrap {
  const user = profile.getUser();
  return { id: user.id, name: user.name ?? defaultLocalProfileName(), avatarUrl: user.avatarUrl };
}

export function terminalSafe(value: string): string {
  return Array.from(value)
    .filter((character) => !/[\p{Cc}\p{Cf}]/u.test(character))
    .slice(0, 80)
    .join("");
}

function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m ${seconds}s`;
}

function formatBytes(value: number): string {
  const gib = value / 1_073_741_824;
  return `${gib.toFixed(1)} GiB`;
}

function stateLabel(state: OpenBotServerStatus["state"]): string {
  const keys = {
    running: "server.localAdmin.state.running",
    starting: "server.localAdmin.state.starting",
    stopped: "server.localAdmin.state.stopped",
    error: "server.localAdmin.state.error",
  } as const;
  return t(keys[state]);
}

function displayState(status: OpenBotServerStatus, now: number): string {
  if (status.state === "running" && now - status.updatedAt > 15_000) return t("server.localAdmin.state.stale");
  return stateLabel(status.state);
}

function drawStatus(status: OpenBotServerStatus | null, now = Date.now()): void {
  const width = Math.max(52, Math.min(100, process.stdout.columns ?? 80));
  const line = "─".repeat(width);
  const title = t("server.localAdmin.title");
  const current = status ?? {
    version: 1 as const,
    state: "stopped" as const,
    startedAt: null,
    updatedAt: 0,
    apiUrl: null,
    devices: [],
    host: null,
  };
  const uptime = current.startedAt === null ? "—" : formatDuration(now - current.startedAt);
  const host = current.host;
  const cpu = host?.cpuPercent === null || host?.cpuPercent === undefined ? "—" : `${host.cpuPercent}%`;
  const memory = host ? `${formatBytes(host.memoryUsedBytes)} / ${formatBytes(host.memoryTotalBytes)}` : "—";
  const deviceLines = current.devices.length
    ? current.devices.map((device) => {
        const name = terminalSafe(device.deviceName) || "Device";
        const platform = device.platform.toUpperCase();
        const date = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
          device.connectedAt,
        );
        return `  ${t("server.localAdmin.deviceRow", { name, platform, date })}`;
      })
    : [`  ${t("server.localAdmin.deviceNone")}`];
  const rows = [
    `  ${t("server.localAdmin.summary")}`,
    "",
    `  ● ${displayState(current, now)}     ${t("server.localAdmin.uptime")}: ${uptime}`,
    `  ${t("server.localAdmin.endpoint")}: ${current.apiUrl ?? "—"}`,
    "",
    `  ${t("server.localAdmin.devices")} (${current.devices.length})`,
    ...deviceLines,
    "",
    `  ${t("server.localAdmin.host")}`,
    `  ${t("server.localAdmin.cpu")}: ${cpu}     ${t("server.localAdmin.memory")}: ${memory}`,
    `  ${t("server.localAdmin.gpu")}: ${host?.gpu ? terminalSafe(host.gpu) : t("server.localAdmin.gpuUnavailable")}`,
    "",
    `  ${t("server.localAdmin.controls")}`,
  ];
  process.stdout.write(`\u001b[2J\u001b[H\u001b[1;36m┌${line}┐\u001b[0m\n`);
  process.stdout.write(
    `\u001b[1;36m│\u001b[0m  \u001b[1m${title}\u001b[0m${" ".repeat(Math.max(1, width - title.length - 2))}\u001b[1;36m│\u001b[0m\n`,
  );
  process.stdout.write(`\u001b[1;36m├${line}┤\u001b[0m\n`);
  for (const row of rows) process.stdout.write(`\u001b[1;36m│\u001b[0m${row}\n`);
  process.stdout.write(`\u001b[1;36m└${line}┘\u001b[0m\n`);
}

async function runServiceAction(action: "start" | "stop" | "restart"): Promise<void> {
  if (process.platform !== "linux") {
    process.stdout.write(`\n${t("server.localAdmin.serviceUnavailable")}\n`);
    return;
  }
  try {
    await execFileAsync("systemctl", ["--user", action, "openbot-server.service"], { timeout: 15_000 });
  } catch {
    process.stdout.write(`\n${t("server.localAdmin.serviceUnavailable")}\n`);
  }
}

async function runTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    const status = await readServerStatus(statusPath);
    if (!status) {
      process.stdout.write(`${t("server.localAdmin.noStatus")}\n`);
      return;
    }
    process.stdout.write(`${t("server.localAdmin.title")} · ${stateLabel(status.state)} · ${status.apiUrl ?? "—"}\n`);
    return;
  }
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  drawStatus(await readServerStatus(statusPath));
  const poll = setInterval(() => void readServerStatus(statusPath).then((status) => drawStatus(status)), 1_000);
  await new Promise<void>((resolvePromise) => {
    const onKey = (value: string) => {
      if (value === "q" || value === "\u0003") {
        process.stdin.off("keypress", listener);
        clearInterval(poll);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\u001b[0m\n");
        resolvePromise();
        return;
      }
      if (value === "s") void runServiceAction("start");
      if (value === "x") void runServiceAction("stop");
      if (value === "r") void runServiceAction("restart");
    };
    const listener = (_character: string, key: { sequence?: string } | undefined) => onKey(key?.sequence ?? "");
    process.stdin.on("keypress", listener);
  });
}

async function readInput(prompt: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(t("server.localAdmin.ttyRequired"));
  process.stdout.write(prompt);
  if (!hidden) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const value = await input.question("");
    input.close();
    return value.trim();
  }
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        cleanup();
        reject(new Error(t("server.localAdmin.ttyRequired")));
      } else if (text === "\r" || text === "\n") {
        cleanup();
        resolvePromise(value);
      } else if (text === "\u007f" || text === "\b") {
        value = value.slice(0, -1);
      } else if (
        !Array.from(text).some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
        })
      ) {
        value += text;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function setupLogin(): Promise<void> {
  await assertIdentityApiPortAvailable();
  process.stdout.write(`${t("server.localAdmin.setupTitle")}\n`);
  const email = await readInput(t("server.localAdmin.emailPrompt"));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) {
    throw new Error(t("server.localAdmin.invalidEmail"));
  }
  const password = await readInput(t("server.localAdmin.passwordPrompt"), true);
  const confirmation = await readInput(t("server.localAdmin.confirmPasswordPrompt"), true);
  if (password !== confirmation) throw new Error(t("server.localAdmin.passwordMismatch"));
  const profile = new LocalProfileStore(profilePath);
  await Effect.runPromise(profile.load());
  const authority = new SelfHostedIdentityAuthority({ path: identityPath });
  await Effect.runPromise(authority.initialize());
  await Effect.runPromise(authority.ensureLocalAccount(bootstrapProfile(profile)));
  await Effect.runPromise(authority.configureLoginCredentials({ email, password }));
  process.stdout.write(`${t("server.localAdmin.setupSuccess")}\n`);
}

async function installCompiledServer(home: string): Promise<string> {
  const directory = resolve(home, ".local", "lib", "openbot-server-cli");
  const executable = resolve(directory, "openbot-server");
  const marker = resolve(directory, ".managed-by-openbot-server-cli");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await readFile(marker, "utf8").catch(() => "");
  const existingBinary = await access(executable)
    .then(() => true)
    .catch(() => false);
  if (existingBinary && !existing) throw new Error("The server executable already exists and was not changed.");
  if (resolve(process.execPath) === executable) return executable;
  if (!/(?:^|\/)bun(?:-[^/]+)?$/u.test(process.execPath)) {
    throw new Error("Run install-autostart from Bun or the installed OpenBot server binary.");
  }

  const temporary = resolve(directory, `.openbot-server-${process.pid}.tmp`);
  await unlink(temporary).catch(() => undefined);
  try {
    await execFileAsync(
      process.execPath,
      ["build", "--compile", fileURLToPath(import.meta.url), "--outfile", temporary],
      {
        cwd: repositoryRoot,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    await chmod(temporary, 0o700);
    await rename(temporary, executable);
    await writeFile(marker, "OpenBot Server CLI managed executable.\n", { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return executable;
}

async function assertIdentityApiPortAvailable(): Promise<void> {
  const [address] = tailscaleAddresses();
  if (!address) throw new Error("Tailscale is not connected. Start Tailscale before configuring the server.");
  await assertTcpPortAvailable(address.address, SELF_HOSTED_IDENTITY_API_PORT);
}

async function serve(): Promise<void> {
  await assertIdentityApiPortAvailable();
  const profile = new LocalProfileStore(profilePath);
  await Effect.runPromise(profile.load());
  const authority = new SelfHostedIdentityAuthority({ path: identityPath });
  await Effect.runPromise(authority.initialize());
  await Effect.runPromise(authority.ensureLocalAccount(bootstrapProfile(profile)));
  const api = new SelfHostedIdentityApiServer({
    authority,
    serverDirectory: new SelfHostedAccountServerDirectory(
      resolve(userDataDirectory, "self-hosted-account-server-directory-v1.json"),
    ),
  });
  const startedAt = Date.now();
  const sampleHostMetrics = createHostMetricsSampler();
  let stopped = false;
  let apiUrl: string | null = null;
  const publish = async (state: OpenBotServerStatus["state"]) => {
    const [host, devices] = await Promise.all([
      sampleHostMetrics(),
      Effect.runPromise(authority.listActiveDeviceSessions()),
    ]);
    await writeServerStatus(statusPath, {
      version: 1,
      state,
      startedAt,
      updatedAt: Date.now(),
      apiUrl,
      devices,
      host,
    });
  };
  try {
    await publish("starting");
    apiUrl = await api.start();
    await publish("running");
    let publishing = false;
    const interval = setInterval(() => {
      if (publishing) return;
      publishing = true;
      void publish("running")
        .catch(() => undefined)
        .finally(() => {
          publishing = false;
        });
    }, statusIntervalMs);
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      await api.stop().catch(() => undefined);
      await publish("stopped").catch(() => undefined);
    };
    process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
    process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
    await new Promise<void>(() => undefined);
  } catch (error) {
    await publish("error").catch(() => undefined);
    throw error;
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "openbot-server <command>",
      "  serve                 Run the independent identity API",
      "  setup                 Set the shared email and password login",
      "  tui                   Open the local status menu",
      "  status                Print the local status summary",
      "  install-autostart     Install server and tray autostart",
      "                        Set OPENBOT_APP_EXECUTABLE if the AppImage is not registered",
      "  remove-autostart      Stop and remove the user service",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "tui";
  if (command === "help" || command === "--help" || command === "-h") return printHelp();
  if (command === "tui") return runTui();
  if (command === "setup") return setupLogin();
  if (command === "serve") return serve();
  if (command === "status") {
    const status = await readServerStatus(statusPath);
    if (!status) throw new Error(t("server.localAdmin.noStatus"));
    process.stdout.write(
      `${t("server.localAdmin.title")} · ${displayState(status, Date.now())} · ${status.apiUrl ?? "—"}\n`,
    );
    return;
  }
  if (command === "install-autostart") {
    if (process.platform !== "linux") throw new Error(t("server.localAdmin.serviceUnavailable"));
    await assertIdentityApiPortAvailable();
    const appExecutable = await installedOpenBotExecutable(homedir(), process.env);
    const serverExecutable = await installCompiledServer(homedir());
    const result = await installUserService({
      serverExecutable,
      userDataDirectory,
      runtimeDirectory: runtimeRoot,
      appExecutable,
    });
    process.stdout.write(
      `${t("server.localAdmin.serviceInstalled")}\n${result.unitPath}\n${result.commandPath}\n${result.trayEntryPath ?? ""}\n`,
    );
    if (!result.trayEntryPath) process.stdout.write(`${t("server.localAdmin.trayEntryMissing")}\n`);
    if (!result.lingerEnabled)
      process.stdout.write(`${t("server.localAdmin.lingerRequired", { user: process.env.USER ?? homedir() })}\n`);
    return;
  }
  if (command === "remove-autostart") {
    if (process.platform !== "linux") throw new Error(t("server.localAdmin.serviceUnavailable"));
    return removeUserService();
  }
  throw new Error("Unknown command. Run `bun scripts/openbot-server.ts --help`.");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : t("server.localAdmin.actionFailed");
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
