import { hostname } from "node:os";
import { isTailscaleApiUrl } from "@openbot/contracts/invite-links";
import type { MobileConnectHostBinding } from "@openbot/contracts/mobile-connect";
import { createMobileConnectUrl } from "@openbot/contracts/mobile-connect";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import type { CentralAuthManager } from "./central-auth-manager";
import { RemoteWorkflowError } from "./remote-service-effects";
import type { SelfHostedIdentityApiServer } from "./self-hosted-identity-api";
import type { SelfHostedIdentityAuthority } from "./self-hosted-identity-authority";

interface MobileConnectHost {
  configure(input: { serverName: string }): Effect.Effect<unknown, RemoteWorkflowError>;
  getStatus(): { configured: boolean; serverName?: string | null };
  getMobileConnectHost(): MobileConnectHostBinding | null;
  start(): Effect.Effect<
    {
      serverId: string | null;
      phase: string;
      apiOnline: boolean;
      apiUrl: string | null;
      message: string | null;
    },
    RemoteWorkflowError
  >;
}

interface MobileConnectHostDependencies {
  centralAuth: Pick<CentralAuthManager, "createMobileConnect">;
  host: MobileConnectHost;
}

interface SelfHostedMobileConnectHost extends MobileConnectHost {
  createMemberDeviceLink(): Effect.Effect<string, RemoteWorkflowError>;
}

export const createHostedMobileConnect = Effect.fn("MobileConnectHost.create")(function* ({
  centralAuth,
  host,
}: MobileConnectHostDependencies) {
  const currentHost = host.getStatus();
  if (!currentHost.configured) yield* host.configure({ serverName: currentHost.serverName?.trim() || hostname() });
  const status = yield* host.start();
  if (!isPublishedHost(status)) {
    return yield* new RemoteWorkflowError({
      cause: new Error(status.message ?? sourceText("error.host.mobileConnectPublishFailed")),
    });
  }
  const binding = host.getMobileConnectHost();
  if (!binding || binding.hostId !== status.serverId)
    return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.host.mobileConnectHostChanged")) });
  return yield* centralAuth.createMobileConnect(binding);
});

/** Creates a QR login ticket using only the identity authority bound to this Tailscale host. */
export const createSelfHostedMobileConnect = Effect.fn("MobileConnectHost.createSelfHosted")(function* ({
  authority,
  identityApi,
  onIdentityApiReady,
  host,
  accountId,
}: {
  authority: SelfHostedIdentityAuthority;
  identityApi: Pick<SelfHostedIdentityApiServer, "start">;
  onIdentityApiReady?: (apiUrl: string) => Promise<void>;
  host: SelfHostedMobileConnectHost;
  accountId: string;
}) {
  const currentHost = host.getStatus();
  if (!currentHost.configured) yield* host.configure({ serverName: currentHost.serverName?.trim() || hostname() });
  const status = yield* host.start();
  if (status.phase !== "online" || !status.apiOnline || !status.apiUrl || !isTailscaleApiUrl(status.apiUrl)) {
    return yield* new RemoteWorkflowError({
      cause: new Error(status.message ?? sourceText("error.host.mobileConnectPublishFailed")),
    });
  }
  const binding = host.getMobileConnectHost();
  if (!binding || binding.hostId !== status.serverId)
    return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.host.mobileConnectHostChanged")) });
  const memberDeviceLink = yield* host.createMemberDeviceLink();
  const apiUrl = yield* Effect.tryPromise({
    try: () => identityApi.start(),
    catch: (cause) => new RemoteWorkflowError({ cause }),
  });
  if (onIdentityApiReady) {
    yield* Effect.tryPromise({
      try: () => onIdentityApiReady(apiUrl),
      catch: (cause) => new RemoteWorkflowError({ cause }),
    });
  }
  const grant = yield* authority
    .issueMobileConnectTicket({ accountId, hostId: binding.hostId, fingerprint: binding.fingerprint })
    .pipe(Effect.mapError((cause) => new RemoteWorkflowError({ cause })));
  return {
    qrData: createMobileConnectUrl({ apiUrl, ticket: grant.ticket, host: binding, memberDeviceLink }),
    expiresAt: grant.expiresAt,
  };
});

function isPublishedHost(status: { phase: string; apiOnline: boolean; apiUrl: string | null }): boolean {
  if (status.phase !== "online" || !status.apiOnline || !status.apiUrl) return false;
  try {
    const protocol = new URL(status.apiUrl).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}
