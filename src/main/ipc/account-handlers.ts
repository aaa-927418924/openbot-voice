// The cloud account: email sign-in, profile, and the mobile devices connected to it.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { CentralAuthManager } from "../central-auth-manager";
import type { HostService } from "../host-service";
import type { LocalProfileStore } from "../local-profile-store";
import { createHostedMobileConnect, createSelfHostedMobileConnect } from "../mobile-connect-host";
import type { SelfHostedIdentityApiServer } from "../self-hosted-identity-api";
import { selfHostedTeamProfile } from "../self-hosted-identity-api";
import type { SelfHostedIdentityAuthority } from "../self-hosted-identity-authority";
import type { TeamStore } from "../team-store";
import { parseEmailCodeVerification, parseProfileName } from "./app-inputs";
import { parseAvatarImage } from "./avatar-inputs";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { stringPayload } from "./validation";

export interface AccountIpcDependencies {
  centralAuth: CentralAuthManager;
  localProfile?: LocalProfileStore;
  selfHostedIdentity?: {
    authority: SelfHostedIdentityAuthority;
    api: SelfHostedIdentityApiServer;
    teamStore: TeamStore;
  };
  host: Pick<HostService, "configure" | "getStatus" | "start" | "getMobileConnectHost">;
}

export function accountIpcHandlers({
  centralAuth,
  host,
  localProfile,
  selfHostedIdentity,
}: AccountIpcDependencies): Pick<IpcGroupHandlers, "auth"> {
  if (localProfile) {
    const disabled = () => {
      throw new Error("OpenBot account services are disabled in local-only mode.");
    };
    const updateLocalProfile = async (state: ReturnType<LocalProfileStore["getState"]>) => {
      const identity = selfHostedIdentity;
      if (identity) {
        const apiUrl = await identity.api.start().catch(() => null);
        const user = localProfile.getUser();
        await Effect.runPromise(
          identity.authority.updateLocalProfile({
            id: user.id,
            name: user.name ?? "OpenBot",
            avatarUrl: user.avatarUrl,
          }),
        );
        await runCauseEffect(identity.teamStore.syncSelfHostedOwner(selfHostedTeamProfile(user, apiUrl)));
      }
      return state;
    };
    return {
      auth: {
        getState: handler(() => localProfile.getState()),
        retry: handler(() => localProfile.getState()),
        requestEmailCode: payloadHandler(stringPayload("email", INPUT_LIMITS.email), disabled),
        verifyEmailCode: payloadHandler(parseEmailCodeVerification, disabled),
        updateName: payloadHandler(parseProfileName, async (name) =>
          updateLocalProfile(await runCauseEffect(localProfile.updateName(name))),
        ),
        updateAvatar: payloadHandler(parseAvatarImage, async (parsed) =>
          updateLocalProfile(await runCauseEffect(localProfile.updateAvatar(parsed))),
        ),
        createMobileConnect: handler(() => {
          if (!selfHostedIdentity) return disabled();
          return runCauseEffect(
            createSelfHostedMobileConnect({
              authority: selfHostedIdentity.authority,
              identityApi: selfHostedIdentity.api,
              onIdentityApiReady: async (apiUrl) => {
                await runCauseEffect(
                  selfHostedIdentity.teamStore.syncSelfHostedOwner(
                    selfHostedTeamProfile(localProfile.getUser(), apiUrl),
                  ),
                );
              },
              host,
              accountId: localProfile.getUser().id,
            }),
          );
        }),
        listMobileConnectedDevices: handler(() => []),
        listAccountSessions: handler(() => []),
        revokeAccountSession: payloadHandler(stringPayload("sessionId", INPUT_LIMITS.identifier), () => undefined),
        revokeMobileConnectedDevice: payloadHandler(
          stringPayload("sessionId", INPUT_LIMITS.identifier),
          () => undefined,
        ),
        logout: handler(() => localProfile.getState()),
      },
    };
  }
  return {
    auth: {
      getState: handler(() => centralAuth.getState()),
      retry: handler(() => runCauseEffect(centralAuth.retry())),
      requestEmailCode: payloadHandler(stringPayload("email", INPUT_LIMITS.email), (email) =>
        runCauseEffect(centralAuth.requestEmailCode(email)),
      ),
      verifyEmailCode: payloadHandler(parseEmailCodeVerification, (verification) =>
        runCauseEffect(centralAuth.verifyEmailCode(verification.challengeId, verification.code)),
      ),
      updateName: payloadHandler(parseProfileName, (name) => runCauseEffect(centralAuth.updateName(name))),
      updateAvatar: payloadHandler(parseAvatarImage, (parsed) => runCauseEffect(centralAuth.updateAvatar(parsed))),
      createMobileConnect: handler(() => runCauseEffect(createHostedMobileConnect({ centralAuth, host }))),
      listMobileConnectedDevices: handler(() => runCauseEffect(centralAuth.listMobileConnectedDevices())),
      listAccountSessions: handler(() => runCauseEffect(centralAuth.listAccountSessions())),
      revokeAccountSession: payloadHandler(stringPayload("sessionId", INPUT_LIMITS.identifier), (sessionId) =>
        runCauseEffect(centralAuth.revokeAccountSession(sessionId)),
      ),
      revokeMobileConnectedDevice: payloadHandler(stringPayload("sessionId", INPUT_LIMITS.identifier), (sessionId) =>
        runCauseEffect(centralAuth.revokeMobileConnectedDevice(sessionId)),
      ),
      logout: handler(() => runCauseEffect(centralAuth.logout())),
    },
  };
}
