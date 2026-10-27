import type { Server } from "node:net";
import { isIP } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";

export interface TailnetBinding {
  address: string;
  family: 4 | 6;
  port: number;
}

/** Stable Team API port so paired clients survive a host restart. */
export const LOCAL_TAILNET_API_PORT = 43123;

function isTailscaleInterfaceName(name: string): boolean {
  // Linux names the TUN interface `tailscale0`; the Windows adapter is `Tailscale`.
  // Do not trust the CGNAT range alone: 100.64/10 may also be assigned to another VPN.
  return name === "tailscale0" || /^tailscale(?:\s+(?:tunnel|adapter))?$/iu.test(name);
}

/** Accept only Tailscale's reserved IPv4 and IPv6 address ranges. */
export function isTailscaleAddress(value: string): boolean {
  const address = value.split("%", 1)[0] ?? value;
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 100 && octets[1] !== undefined && octets[1] >= 64 && octets[1] <= 127;
  }
  if (isIP(address) !== 6) return false;
  const groups = expandIpv6(address);
  return groups?.[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0;
}

/** Prefer IPv4 because it works consistently across the desktop and Android Tailscale clients. */
export function tailscaleAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): Array<{ address: string; family: 4 | 6 }> {
  const found: Array<{ address: string; family: 4 | 6 }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!isTailscaleInterfaceName(name)) continue;
    for (const entry of entries ?? []) {
      const family = entry.family === "IPv4" ? 4 : entry.family === "IPv6" ? 6 : null;
      if (!entry.internal && family && isTailscaleAddress(entry.address))
        found.push({ address: entry.address, family });
    }
  }
  return found.sort((left, right) => left.family - right.family);
}

export function listenOnTailscale(
  server: Server,
  noPort: () => Error,
  port = LOCAL_TAILNET_API_PORT,
): Promise<TailnetBinding> {
  const [binding] = tailscaleAddresses();
  if (!binding) return Promise.reject(new Error("Tailscale is not connected. Start Tailscale before sharing OpenBot."));
  return new Promise<TailnetBinding>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, binding.address, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(noPort());
        return;
      }
      resolve({ address: binding.address, family: binding.family, port: address.port });
    });
  });
}

export function tailnetUrl(binding: Pick<TailnetBinding, "address" | "family" | "port">): string {
  const host = binding.family === 6 ? `[${binding.address.split("%", 1)[0]}]` : binding.address;
  return `http://${host}:${binding.port}`;
}

function expandIpv6(value: string): number[] | null {
  const lower = value.toLowerCase();
  const separator = lower.indexOf("::");
  const leftText = separator < 0 ? lower : lower.slice(0, separator);
  const rightText = separator < 0 ? "" : lower.slice(separator + 2);
  const parse = (part: string) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const left = parse(leftText);
  const right = parse(rightText);
  if ([...left, ...right].some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  if (separator < 0) return left.length === 8 ? left : null;
  const zeroes = 8 - left.length - right.length;
  if (zeroes < 1) return null;
  return [...left, ...Array.from({ length: zeroes }, () => 0), ...right];
}
