import { describe, expect, it } from "vitest";
import { remoteCommandRequiresAutoReview } from "./remote-device-command-risk";

describe("remote device command AutoReview", () => {
  it("blocks destructive sync and mirror operations", () => {
    const commands = [
      ["rsync", ["-a", "--delete", "source/", "destination/"]],
      ["rsync", ["--delete-after", "source/", "destination/"]],
      ["rsync", ["--remove-source-files", "source/", "destination/"]],
      ["robocopy.exe", ["C:\\source", "D:\\target", "/MIR"]],
      ["robocopy", ["C:\\source", "D:\\target", "/PURGE"]],
      ["robocopy", ["C:\\source", "D:\\target", "/MOVE"]],
      ["rclone", ["sync", "source", "destination"]],
      ["aws", ["s3", "sync", "source", "destination", "--delete"]],
    ] as const;

    for (const [executable, args] of commands) {
      expect(remoteCommandRequiresAutoReview(executable, args), `${executable} ${args.join(" ")}`).toBe(true);
    }
  });

  it("blocks shell-based execution and known destructive commands", () => {
    expect(remoteCommandRequiresAutoReview("bash", ["-c", "echo unsafe"])).toBe(true);
    expect(remoteCommandRequiresAutoReview("git", ["clean", "-fd"])).toBe(true);
    expect(remoteCommandRequiresAutoReview("git", ["push", "--force-with-lease"])).toBe(true);
  });

  it("allows ordinary read-only commands and version checks", () => {
    expect(remoteCommandRequiresAutoReview("git", ["status", "--short"])).toBe(false);
    expect(remoteCommandRequiresAutoReview("ls", ["-la"])).toBe(false);
    expect(remoteCommandRequiresAutoReview("node", ["--version"])).toBe(false);
  });
});
