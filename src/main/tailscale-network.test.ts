// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isTailscaleAddress, tailnetUrl, tailscaleAddresses } from "./tailscale-network";

describe("Tailscale address selection", () => {
  it("accepts only the reserved tailnet ranges", () => {
    expect(isTailscaleAddress("100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("100.127.255.255")).toBe(true);
    expect(isTailscaleAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTailscaleAddress("fd7a:115c:a1e0:1234::abcd%tailscale0")).toBe(true);
    expect(isTailscaleAddress("100.63.255.255")).toBe(false);
    expect(isTailscaleAddress("100.128.0.1")).toBe(false);
    expect(isTailscaleAddress("fd7a:115c:a1e1::1")).toBe(false);
    expect(isTailscaleAddress("192.168.1.9")).toBe(false);
    expect(isTailscaleAddress("localhost")).toBe(false);
  });

  it("selects an external Tailscale address and prefers IPv4", () => {
    expect(
      tailscaleAddresses({
        tailscale0: [
          {
            address: "fd7a:115c:a1e0::1",
            family: "IPv6",
            internal: false,
            mac: "",
            netmask: "",
            cidr: "fd7a:115c:a1e0::1/64",
            scopeid: 0,
          },
          { address: "100.100.10.2", family: "IPv4", internal: false, mac: "", netmask: "", cidr: "100.100.10.2/32" },
        ],
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, mac: "", netmask: "", cidr: "127.0.0.1/8" }],
      }),
    ).toEqual([
      { address: "100.100.10.2", family: 4 },
      { address: "fd7a:115c:a1e0::1", family: 6 },
    ]);
  });

  it("brackets IPv6 addresses in HTTP URLs", () => {
    expect(tailnetUrl({ address: "fd7a:115c:a1e0::1", family: 6, port: 43210 })).toBe(
      "http://[fd7a:115c:a1e0::1]:43210",
    );
  });
});
