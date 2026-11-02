import type { RemoteDesktopSession } from "@openbot/contracts/ipc";

interface RemoteDesktopViewerUrlOptions {
  direct: boolean;
  baseUrl?: string;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/** Builds the viewer URL and carries WebRTC-only viewer sockets through the established bridge. */
export function remoteDesktopViewerUrl(
  session: Pick<RemoteDesktopSession, "viewerUrl" | "viewerGrant">,
  options: RemoteDesktopViewerUrlOptions,
): string {
  const url = new URL(session.viewerUrl);
  if (!options.direct && isLoopbackHost(url.hostname) && options.baseUrl) {
    try {
      const base = new URL(options.baseUrl);
      if ((base.protocol === "http:" || base.protocol === "https:") && !base.username && !base.password) {
        url.protocol = base.protocol;
        url.host = base.host;
        // Setting `host` without an explicit port leaves the old viewer port intact.
        // The viewer is served by the same OpenBot API origin as `baseUrl`.
        url.port = base.port;
      }
    } catch {
      // Keep the session-provided URL when the account directory URL is malformed.
    }
  }
  if (options.direct) url.searchParams.delete("openbotRelay");
  else url.searchParams.set("openbotRelay", "1");
  url.hash = session.viewerGrant;
  return url.toString();
}
