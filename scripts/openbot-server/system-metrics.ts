import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HostMetrics {
  readonly cpuPercent: number | null;
  readonly memoryUsedBytes: number;
  readonly memoryTotalBytes: number;
  readonly gpu: string | null;
}

interface CpuTimes {
  readonly idle: number;
  readonly total: number;
}

function readCpuTimes(): CpuTimes {
  const cores = cpus();
  let idle = 0;
  let total = 0;
  for (const core of cores) {
    idle += core.times.idle;
    total += core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq;
  }
  return { idle, total };
}

export function cpuPercentBetween(previous: CpuTimes, current: CpuTimes): number | null {
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return Math.max(0, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
}

async function readNvidiaGpu(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 1_200, maxBuffer: 4_096 },
    );
    const firstLine = stdout.split("\n", 1)[0]?.trim();
    if (!firstLine) return null;
    const [name, utilization, memoryUsed, memoryTotal] = firstLine.split(",").map((part) => part.trim());
    if (!name) return null;
    const usage = Number(utilization);
    const used = Number(memoryUsed);
    const total = Number(memoryTotal);
    const detail =
      Number.isFinite(usage) && Number.isFinite(used) && Number.isFinite(total)
        ? ` · ${usage}% · ${used}/${total} MiB`
        : "";
    return `${name}${detail}`;
  } catch {
    return null;
  }
}

async function readDrmGpu(): Promise<string | null> {
  try {
    const cards = (await readdir("/sys/class/drm")).filter((name) => /^card\d+$/u.test(name)).sort();
    for (const card of cards) {
      const devicePath = `/sys/class/drm/${card}/device`;
      const [vendor, device, busy, memoryUsed, memoryTotal] = await Promise.all(
        ["vendor", "device", "gpu_busy_percent", "mem_info_vram_used", "mem_info_vram_total"].map(async (name) => {
          try {
            return (await readFile(`${devicePath}/${name}`, "utf8")).trim();
          } catch {
            return "";
          }
        }),
      );
      if (!vendor || !device) continue;
      const model = `${vendor}:${device}`;
      const details = busy ? ` · ${busy}%` : "";
      const memory =
        memoryUsed && memoryTotal
          ? ` · ${Math.round(Number(memoryUsed) / 1_048_576)}/${Math.round(Number(memoryTotal) / 1_048_576)} MiB`
          : "";
      return `${model}${details}${memory}`;
    }
  } catch {
    // The DRM sysfs path is optional on headless and virtual hosts.
  }
  return null;
}

export function createHostMetricsSampler(): () => Promise<HostMetrics> {
  let previous = readCpuTimes();
  return async () => {
    const current = readCpuTimes();
    const cpuPercent = cpuPercentBetween(previous, current);
    previous = current;
    const memoryTotalBytes = totalmem();
    const memoryUsedBytes = memoryTotalBytes - freemem();
    const gpu = (await readNvidiaGpu()) ?? (await readDrmGpu());
    return { cpuPercent, memoryUsedBytes, memoryTotalBytes, gpu };
  };
}
