import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveLocale, translateFor } from "@openbot/i18n";
import { app, Menu, nativeImage, Tray } from "electron";
import { runtimeDirectory } from "../../scripts/openbot-server/paths";
import { readServerStatus, statusFilePath } from "../../scripts/openbot-server/status-file";

const execFileAsync = promisify(execFile);
const locale = resolveLocale("system", process.env.LANG ?? "en");
const t = translateFor(locale);

async function serviceAction(action: "start" | "stop" | "restart"): Promise<void> {
  await execFileAsync("systemctl", ["--user", action, "openbot-server.service"], { timeout: 15_000 }).catch(() => {
    process.stderr.write(`${t("server.localAdmin.actionFailed")}\n`);
  });
}

function openStatusTui(): void {
  const executable = join(homedir(), ".local", "bin", "openbot-server-local");
  if (!existsSync(executable)) {
    process.stderr.write(`${t("server.localAdmin.noStatus")}\n`);
    return;
  }
  execFile(
    "x-terminal-emulator",
    ["-e", executable, "tui"],
    { env: { ...process.env, PATH: `${join(homedir(), ".local", "bin")}:${process.env.PATH ?? ""}` } },
    (error) => {
      if (error) process.stderr.write(`${t("server.localAdmin.actionFailed")}\n`);
    },
  );
}

async function acquireTrayLock(path: string): Promise<boolean> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const lockPath = join(path, "tray.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(`${process.pid}\n`);
      await lock.close();
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const contents = await readFile(lockPath, "utf8").catch(() => "");
      const pid = Number(contents.trim());
      let stale = !Number.isSafeInteger(pid) || pid < 2;
      if (!stale) {
        try {
          process.kill(pid, 0);
          const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
          // Treat an unreadable command line as an active lock. A duplicate tray is worse
          // than requiring manual cleanup of a stale lock in a hardened /proc setup.
          stale = commandLine.length > 0 && !commandLine.includes("--openbot-server-tray");
        } catch (processError) {
          stale =
            typeof processError === "object" &&
            processError !== null &&
            "code" in processError &&
            processError.code === "ESRCH";
        }
      }
      if (!stale) return false;
      await unlink(lockPath).catch(() => undefined);
    }
  }
  return false;
}

export async function startLinuxServerTray(): Promise<void> {
  if (process.platform !== "linux") {
    app.quit();
    return;
  }
  app.setName("OpenBot Server");
  const runtimeRoot = runtimeDirectory();
  if (!(await acquireTrayLock(runtimeRoot))) {
    app.quit();
    return;
  }
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "icons", "icon-production.png")
    : resolve(__dirname, "../../build/icon-production.png");
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 24, height: 24 }));
  const statusPath = statusFilePath(runtimeRoot);
  const trayLockPath = join(runtimeRoot, "tray.lock");
  let refreshing = false;
  let closed = false;

  const refresh = async () => {
    if (refreshing || closed) return;
    refreshing = true;
    try {
      const status = await readServerStatus(statusPath);
      const summary = status
        ? status.state === "running" && Date.now() - status.updatedAt > 15_000
          ? t("server.localAdmin.state.stale")
          : t(`server.localAdmin.state.${status.state}`)
        : t("server.localAdmin.state.stopped");
      tray.setToolTip(`${t("server.localAdmin.title")} · ${summary}`);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: t("server.localAdmin.title"), enabled: false },
          { label: summary, enabled: false },
          { type: "separator" },
          { label: t("server.localAdmin.trayOpen"), click: openStatusTui },
          { label: t("server.localAdmin.trayStart"), click: () => void serviceAction("start") },
          { label: t("server.localAdmin.trayStop"), click: () => void serviceAction("stop") },
          { label: t("server.localAdmin.trayRestart"), click: () => void serviceAction("restart") },
          { type: "separator" },
          { label: t("server.localAdmin.trayQuit"), click: () => app.quit() },
        ]),
      );
    } catch {
      tray.setToolTip(t("server.localAdmin.title"));
    } finally {
      refreshing = false;
    }
  };

  const timer = setInterval(() => void refresh(), 3_000);
  tray.on("double-click", openStatusTui);
  app.on("before-quit", () => {
    closed = true;
    clearInterval(timer);
    tray.destroy();
    void unlink(trayLockPath).catch(() => undefined);
  });
  void refresh();
}
