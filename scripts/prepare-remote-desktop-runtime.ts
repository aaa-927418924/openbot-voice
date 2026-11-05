import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { hasPinnedRemoteDesktopArtifacts, loadNativeRuntimeLock } from "./native-runtime-lock";

const lock = await loadNativeRuntimeLock();
const platform = process.argv[2] ?? process.platform;
const architecture = process.argv[3] ?? process.arch;
if (hasPinnedRemoteDesktopArtifacts(lock)) {
  execFileSync("bun", ["scripts/install-remote-desktop-runtime.ts", platform, architecture], { stdio: "inherit" });
} else if (process.env.OPENBOT_ALLOW_RUNTIME_SOURCE_BUILD === "1") {
  execFileSync("bun", ["scripts/build-remote-desktop-runtime.ts"], { stdio: "inherit" });
} else if (await exists(resolve("build/remote-desktop-runtime/source-manifest.json"))) {
  try {
    execFileSync("bun", ["scripts/verify-remote-desktop-runtime.ts", platform === "win32" ? "--windows" : "--linux"], {
      stdio: "inherit",
    });
  } catch (cause) {
    throw new Error("The local remote desktop runtime cache failed verification.", { cause });
  }
} else {
  throw new Error(
    "No reusable remote desktop runtime is pinned. Publish and pin it, or set OPENBOT_ALLOW_RUNTIME_SOURCE_BUILD=1 for the bootstrap CI only.",
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
