import { describe, expect, it } from "vitest";
import { reviewRemoteCommandLocally } from "./remote-device-command-local-review";

describe("remote device local command review", () => {
  it("allows a bounded, read-only Windows Downloads listing without model review", () => {
    const review = reviewRemoteCommandLocally(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-ChildItem -LiteralPath "$env:USERPROFILE\\Downloads" -File | Sort-Object Length -Descending | Select-Object Name,Length -First 20',
      ],
      "win32",
    );

    expect(review).toEqual({ allowed: true, rule: "read_only_powershell_listing" });
  });

  it("blocks destructive PowerShell, script execution, and shell chaining", () => {
    for (const args of [
      ["-NoProfile", "-NonInteractive", "-Command", 'Remove-Item "$env:USERPROFILE\\Downloads\\*"'],
      ["-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem . | Invoke-Expression"],
      ["-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem .; whoami"],
      ["-NoProfile", "-NonInteractive", "-File", "script.ps1"],
    ]) {
      expect(reviewRemoteCommandLocally("powershell.exe", args, "win32").allowed).toBe(false);
    }
  });

  it("blocks traversal paths and unknown commands", () => {
    expect(
      reviewRemoteCommandLocally(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem -LiteralPath ..\\Secrets"],
        "win32",
      ).allowed,
    ).toBe(false);
    expect(reviewRemoteCommandLocally("python", ["-c", "print(1)"], "linux").allowed).toBe(false);
    expect(reviewRemoteCommandLocally("rm", ["-rf", "/tmp/example"], "linux").allowed).toBe(false);
  });

  it("permits narrow read-only system commands", () => {
    expect(reviewRemoteCommandLocally("ls", ["-lah"], "linux")).toEqual({
      allowed: true,
      rule: "read_only_system_command",
    });
    expect(reviewRemoteCommandLocally("du", ["-sh", "Downloads"], "linux").allowed).toBe(true);
    expect(reviewRemoteCommandLocally("ls", ["--color=always"], "linux").allowed).toBe(false);
  });
});
