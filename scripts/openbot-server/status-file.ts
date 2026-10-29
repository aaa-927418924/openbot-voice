import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { SelfHostedDeviceSession } from "../../src/main/self-hosted-identity-authority";
import type { HostMetrics } from "./system-metrics";

export interface OpenBotServerStatus {
  readonly version: 1;
  readonly state: "starting" | "running" | "stopped" | "error";
  readonly startedAt: number | null;
  readonly updatedAt: number;
  readonly apiUrl: string | null;
  readonly devices: readonly SelfHostedDeviceSession[];
  readonly host: HostMetrics | null;
}

export function statusFilePath(runtimeRoot: string): string {
  return join(runtimeRoot, "status.json");
}

export async function writeServerStatus(path: string, status: OpenBotServerStatus): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(status), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, path);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDeviceSession(value: unknown): value is SelfHostedDeviceSession {
  return (
    isDynamicRecord(value) &&
    typeof value.deviceName === "string" &&
    ["ios", "android", "unknown"].includes(String(value.platform)) &&
    isNumber(value.connectedAt) &&
    isNumber(value.expiresAt)
  );
}

function isHostMetrics(value: unknown): value is HostMetrics {
  return (
    isDynamicRecord(value) &&
    (value.cpuPercent === null || isNumber(value.cpuPercent)) &&
    isNumber(value.memoryUsedBytes) &&
    isNumber(value.memoryTotalBytes) &&
    (value.gpu === null || typeof value.gpu === "string")
  );
}

function decodeServerStatus(value: unknown): OpenBotServerStatus | null {
  if (!isDynamicRecord(value)) return null;
  const state = value.state;
  if (
    value.version !== 1 ||
    !(state === "starting" || state === "running" || state === "stopped" || state === "error") ||
    !(value.startedAt === null || isNumber(value.startedAt)) ||
    !isNumber(value.updatedAt) ||
    !(value.apiUrl === null || typeof value.apiUrl === "string") ||
    !Array.isArray(value.devices) ||
    !value.devices.every(isDeviceSession) ||
    !(value.host === null || isHostMetrics(value.host))
  ) {
    return null;
  }
  return {
    version: 1,
    state,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    apiUrl: value.apiUrl,
    devices: value.devices.filter(isDeviceSession),
    host: value.host,
  };
}

export async function readServerStatus(path: string): Promise<OpenBotServerStatus | null> {
  try {
    return decodeServerStatus(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}
