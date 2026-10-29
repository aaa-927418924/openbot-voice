import { describe, expect, it } from "vitest";
import { trayAutostartEntry, userServiceUnit } from "./autostart";

describe("Linux OpenBot server autostart", () => {
  it("creates a user service that restarts after crashes and boots with the user session", () => {
    const unit = userServiceUnit({
      serverExecutable: "/home/example/.local/lib/openbot-server-cli/openbot-server",
      userDataDirectory: "/home/example/.config/OpenBot",
      runtimeDirectory: "/run/user/1000/openbot-server",
    });

    expect(unit).toContain('ExecStart="/home/example/.local/lib/openbot-server-cli/openbot-server" serve');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("StartLimitIntervalSec=0");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).not.toContain("chat.db");
  });

  it("starts the tray from the installed OpenBot launcher without opening its regular window", () => {
    const entry = trayAutostartEntry("/home/example/OpenBot AppImage", "/run/user/1000/openbot-server");

    expect(entry).toContain('OPENBOT_SERVER_RUNTIME_DIR="/run/user/1000/openbot-server"');
    expect(entry).toContain('"/home/example/OpenBot AppImage" --openbot-server-tray');
    expect(entry).toContain("Terminal=false");
  });
});
