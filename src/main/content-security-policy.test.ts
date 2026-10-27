import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, readSelfHostedSignalOrigin } from "./content-security-policy";

describe("buildContentSecurityPolicy", () => {
  it("allows the production analytics endpoint", () => {
    const policy = buildContentSecurityPolicy(true);

    expect(policy).toContain(
      "connect-src 'self' openbot-attachment: openbot-remote-attachment: https://analytics.openbot.run ws://127.0.0.1:* wss://*.openbot.run",
    );
    expect(policy.split("; ").find((directive) => directive.startsWith("connect-src "))).not.toContain("localhost");
  });

  it.each([true, false])("allows loopback viewer frames when packaged=%s", (packaged) => {
    const directives = buildContentSecurityPolicy(packaged).split("; ");
    expect(directives.find((directive) => directive.startsWith("frame-src "))).toBe(
      "frame-src 'self' openbot-attachment: openbot-remote-attachment: https://*.openbot.run http://127.0.0.1:* http://localhost:*",
    );
    expect(directives.find((directive) => directive.startsWith("script-src "))).toBe("script-src 'self'");
  });

  it("allows only saved Tailscale API origins as HTTP viewer frames", () => {
    const policy = buildContentSecurityPolicy(true, undefined, null, [
      "http://100.100.135.107:43123/",
      "http://100.63.1.2:43123/",
      "https://100.100.135.107:43123/",
      "http://192.168.1.2:43123/",
    ]);
    const frame = policy.split("; ").find((directive) => directive.startsWith("frame-src "));
    expect(frame).toBe(
      "frame-src 'self' openbot-attachment: openbot-remote-attachment: https://*.openbot.run http://127.0.0.1:* http://localhost:* http://100.100.135.107:43123",
    );
  });

  it("lets the renderer play an attachment recording, but only from the attachment schemes", () => {
    const policy = buildContentSecurityPolicy(true);

    expect(policy).toContain("media-src 'self' blob: openbot-attachment: openbot-remote-attachment:");
    expect(policy).not.toContain("media-src 'self' blob: openbot-attachment: openbot-remote-attachment: https:");
  });

  it("keeps local development sources", () => {
    const policy = buildContentSecurityPolicy(false, "ws://192.168.1.143:3101/v1/signal");

    expect(policy).toContain("http://localhost:*");
    expect(policy).toContain("ws://localhost:*");
    expect(policy).toContain("ws://192.168.1.143:3101");
  });

  it("does not add public or production Signal origins through the development option", () => {
    expect(buildContentSecurityPolicy(false, "ws://signal.example.com/v1/signal")).not.toContain(
      "ws://signal.example.com",
    );
    expect(buildContentSecurityPolicy(true, "ws://192.168.1.143:3101/v1/signal")).not.toContain(
      "ws://192.168.1.143:3101",
    );
  });

  it("adds only the origin of a self-hosted Signal to connect-src", () => {
    const origin = readSelfHostedSignalOrigin("https://api.example.com", "wss://signal.example.com:8443/v1/signal");
    const connect = buildContentSecurityPolicy(true, undefined, origin)
      .split("; ")
      .find((directive) => directive.startsWith("connect-src "));

    expect(origin).toBe("wss://signal.example.com:8443");
    expect(connect).toContain(" wss://signal.example.com:8443");
    expect(readSelfHostedSignalOrigin(undefined, undefined)).toBeNull();
  });

  it.each([
    [undefined, "wss://signal.example.com/v1/signal", "OPENBOT_REMOTE_SIGNAL_URL needs OPENBOT_AUTH_API_URL."],
    ["https://api.example.com", "ws://signal.example.com/v1/signal", "must be a wss: URL"],
    ["https://api.example.com", "https://signal.example.com/v1/signal", "must be a wss: URL"],
    ["https://api.example.com", "wss://user:pass@signal.example.com/v1/signal", "must be a wss: URL"],
  ])("refuses a self-hosted Signal URL with auth API %s and Signal %s", (authApiUrl, signalUrl, message) => {
    expect(() => readSelfHostedSignalOrigin(authApiUrl, signalUrl)).toThrow(message);
  });
});
