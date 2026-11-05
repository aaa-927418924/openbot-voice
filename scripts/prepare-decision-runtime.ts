import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";

const LLAMA_RELEASE = "b11960";
const MODEL_REVISION = "4a181094d1b6addfaa3a0956f78e7ab2aa406a0c";
const MODEL_LICENSE_SHA256 = "4d28ca14dedc0b3d0fcc2b3339f0e79931faa33874f3d24f522183a8fc70068c";
const RELEASES_ROOT = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}`;
const MODEL_LICENSE_URL = `https://huggingface.co/LiquidAI/d1-2B-GGUF/resolve/${MODEL_REVISION}/LICENSE`;
const logger = createOpenBotLogger("prepare-decision-runtime");

const artifacts = {
  "linux-x64": {
    archive: "llama-b11960-bin-ubuntu-x64.tar.gz",
    sha256: "31cc3a6bc638ac6c48dc4b1b74888f1eaadf3d14227c1e5f67daf9a49541d97a",
    kind: "tar.gz",
    prefix: "llama-b11960/",
  },
  "linux-arm64": {
    archive: "llama-b11960-bin-ubuntu-arm64.tar.gz",
    sha256: "0065ecfbffe8a790bb0d28059a3320cdc8f723b7f3f248cdc8bfc04790927715",
    kind: "tar.gz",
    prefix: "llama-b11960/",
  },
  "win32-x64": {
    archive: "llama-b11960-bin-win-cpu-x64.zip",
    sha256: "73f962f82850d244db47eaacb9d913637027b82399124324298576d58c5f4287",
    kind: "zip",
    prefix: "",
  },
  "win32-arm64": {
    archive: "llama-b11960-bin-win-cpu-arm64.zip",
    sha256: "77349357c38da235bb0eed37bcc5ecf3efef21bb5dc42c2269589c0e71cfa00f",
    kind: "zip",
    prefix: "",
  },
} as const;

type RuntimeTarget = keyof typeof artifacts;

export async function prepareDecisionRuntime(
  target: RuntimeTarget,
  options: { root?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const root = options.root ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? fetch;
  const artifact = artifacts[target];
  if (!artifact) throw new Error(`Unsupported local decision runtime target: ${target}.`);

  const downloadRoot = join(root, ".openbot-build", "decision-runtime", "downloads");
  const downloadPath = join(downloadRoot, artifact.archive);
  await mkdir(downloadRoot, { recursive: true });
  if (!(await hasSha256(downloadPath, artifact.sha256))) {
    const bytes = await download(fetchImpl, `${RELEASES_ROOT}/${artifact.archive}`);
    if (sha256(bytes) !== artifact.sha256) throw new Error(`The ${artifact.archive} checksum is invalid.`);
    await writeFile(downloadPath, bytes, { mode: 0o600 });
  }

  const licensePath = join(downloadRoot, "LICENSE-LFM-1.0");
  if (!(await hasSha256(licensePath, MODEL_LICENSE_SHA256))) {
    const licenseBytes = await download(fetchImpl, MODEL_LICENSE_URL);
    if (sha256(licenseBytes) !== MODEL_LICENSE_SHA256) throw new Error("The Liquid model license checksum is invalid.");
    await writeFile(licensePath, licenseBytes, { mode: 0o600 });
  }

  const extractionRoot = await mkdtemp(join(tmpdir(), "openbot-decision-runtime-"));
  const extractedRoot = join(extractionRoot, "extracted");
  const separator = target.indexOf("-");
  const platform = target.slice(0, separator);
  const architecture = target.slice(separator + 1);
  const outputRoot = join(root, "build", "decision-runtime", platform, architecture);
  const stagingRoot = `${outputRoot}.installing`;
  try {
    await mkdir(extractedRoot, { recursive: true });
    if (artifact.kind === "tar.gz") {
      execFileSync("tar", ["-xzf", downloadPath, "-C", extractedRoot, "--no-same-owner"], { stdio: "inherit" });
    } else if (process.platform === "win32") {
      execFileSync("tar", ["-xf", downloadPath, "-C", extractedRoot], { stdio: "inherit" });
    } else {
      execFileSync("unzip", ["-q", "-o", downloadPath, "-d", extractedRoot], { stdio: "inherit" });
    }

    const archiveRoot = artifact.prefix ? join(extractedRoot, artifact.prefix.slice(0, -1)) : extractedRoot;
    const entries = await readdir(archiveRoot, { withFileTypes: true });
    await rm(stagingRoot, { recursive: true, force: true });
    await mkdir(stagingRoot, { recursive: true });
    let serverFound = false;
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const isWindowsServer = target.startsWith("win32-") && entry.name === "llama-server.exe";
      const isLinuxServer = target.startsWith("linux-") && entry.name === "llama-server";
      const isLibrary = target.startsWith("win32-") ? entry.name.endsWith(".dll") : /\.so(?:\.\d+)*$/u.test(entry.name);
      const isLicense = entry.name === "LICENSE" || entry.name === "LICENSE-LLVM-OpenMP";
      if (!isWindowsServer && !isLinuxServer && !isLibrary && !isLicense) continue;
      await copyFile(join(archiveRoot, entry.name), join(stagingRoot, entry.name));
      if (isWindowsServer || isLinuxServer) serverFound = true;
      if (target.startsWith("linux-") && (isWindowsServer || isLinuxServer)) {
        await chmod(join(stagingRoot, entry.name), 0o755);
      }
    }
    if (!serverFound) throw new Error(`The ${artifact.archive} archive did not contain llama-server.`);
    await copyFile(licensePath, join(stagingRoot, "LICENSE-LFM-1.0"));
    await writeFile(
      join(stagingRoot, "MODEL-INFO.txt"),
      [
        "LiquidAI/d1-2B-GGUF",
        `Revision: ${MODEL_REVISION}`,
        "Quantization: Q4_K_M",
        "Model weights are downloaded on first use and verified by SHA-256.",
        "License: LFM Open License v1.0 (LICENSE-LFM-1.0)",
        "Runtime: llama.cpp b11960 (see LICENSE)",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(dirname(outputRoot), { recursive: true });
    await rename(stagingRoot, outputRoot);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
  }
  logger.info(`Prepared local d1 command-review runtime for ${target}.`);
}

async function hasSha256(path: string, expected: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return false;
    return sha256(await readFile(path)) === expected;
  } catch {
    return false;
  }
}

async function download(fetchImpl: typeof fetch, url: string): Promise<Uint8Array> {
  const response = await fetchImpl(url, { redirect: "follow", headers: { "User-Agent": "OpenBot-runtime-installer" } });
  if (!response.ok) throw new Error(`A pinned local decision runtime asset returned HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

if (import.meta.main) {
  const platform = process.argv[2] ?? process.platform;
  const architecture = process.argv[3] ?? process.arch;
  const targetName = `${platform}-${architecture}`;
  if (!isRuntimeTarget(targetName)) throw new Error(`Unsupported local decision runtime target: ${targetName}.`);
  const target = targetName;
  await prepareDecisionRuntime(target);
}

function isRuntimeTarget(value: string): value is RuntimeTarget {
  return Object.hasOwn(artifacts, value);
}
