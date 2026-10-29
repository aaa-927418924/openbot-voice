import { app } from "electron";

if (process.argv.includes("--openbot-server-tray")) {
  if (process.platform !== "linux") {
    app.quit();
  } else {
    void app
      .whenReady()
      .then(async () => {
        const { startLinuxServerTray } = await import("./linux-server-tray");
        await startLinuxServerTray();
      })
      .catch(() => app.quit());
  }
} else {
  void import("./desktop-main");
}
