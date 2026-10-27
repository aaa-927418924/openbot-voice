// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isTailscaleAddress, LOCAL_TAILNET_API_PORT, tailnetUrl, tailscaleAddresses } from "./tailscale-network";

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

  it("selects only interfaces named for Tailscale, even when another VPN uses the CGNAT range", () => {
    expect(
      tailscaleAddresses({
        Ethernet: [
          { address: "100.100.10.9", family: "IPv4", internal: false, mac: "", netmask: "", cidr: "100.100.10.9/32" },
        ],
        Tailscale: [
          { address: "100.100.10.2", family: "IPv4", internal: false, mac: "", netmask: "", cidr: "100.100.10.2/32" },
        ],
      }),
    ).toEqual([{ address: "100.100.10.2", family: 4 }]);
  });

  it("uses a stable port in its direct Tailscale API URL", () => {
    expect(LOCAL_TAILNET_API_PORT).toBe(43123);
    expect(tailnetUrl({ address: "fd7a:115c:a1e0::1", family: 6, port: LOCAL_TAILNET_API_PORT })).toBe(
      "http://[fd7a:115c:a1e0::1]:43123",
    );
  });
});
