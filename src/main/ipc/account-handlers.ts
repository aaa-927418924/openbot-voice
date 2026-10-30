// The cloud account: email sign-in, profile, and the mobile devices connected to it.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { SelfHostedAccountLoginInput, SelfHostedAccountRegistrationInput } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { CentralAuthManager } from "../central-auth-manager";
import type { HostService } from "../host-service";
import type { LocalProfileStore } from "../local-profile-store";
import { createHostedMobileConnect, createSelfHostedMobileConnect } from "../mobile-connect-host";
import type { RemoteServerManager } from "../remote-server-manager";
import type { SelfHostedDesktopAccountManager } from "../self-hosted-desktop-account";
import type { SelfHostedIdentityApiServer } from "../self-hosted-identity-api";
import { selfHostedTeamProfile } from "../self-hosted-identity-api";
import type { SelfHostedIdentityAuthority } from "../self-hosted-identity-authority";
import type { TeamStore } from "../team-store";
import { parseEmailCodeVerification, parseProfileName } from "./app-inputs";
import { parseAvatarImage } from "./avatar-inputs";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { stringPayload } from "./validation";

function parseSelfHostedLogin(input: unknown): SelfHostedAccountLoginInput {
  if (
    !isDynamicRecord(input) ||
    !isString(input.serverAddress) ||
    input.serverAddress.length > 2048 ||
    !isString(input.email) ||
    input.email.length > INPUT_LIMITS.email ||
    !isString(input.password) ||
    input.password.length > 256
  )
    throw new Error("ログイン情報を確認してください。");
  return { serverAddress: input.serverAddress, email: input.email, password: input.password };
}

function parseSelfHostedRegistration(input: unknown): SelfHostedAccountRegistrationInput {
  const login = parseSelfHostedLogin(input);
  if (!isDynamicRecord(input) || !isString(input.name) || input.name.length > INPUT_LIMITS.profileName) {
    throw new Error("アカウント名を確認してください。");
  }
  return { ...login, name: input.name };
}

export interface AccountIpcDependencies {
  centralAuth: CentralAuthManager;
  localProfile?: LocalProfileStore;
  selfHostedDesktopAccount?: SelfHostedDesktopAccountManager;
  remoteServers?: Pick<RemoteServerManager, "syncAccountDirectory">;
  selfHostedIdentity?: {
    authority: SelfHostedIdentityAuthority;
    api: SelfHostedIdentityApiServer;
    teamStore: TeamStore;
  };
  host: Pick<HostService, "configure" | "getStatus" | "start" | "getMobileConnectHost" | "createMemberDeviceLink">;
}

export function accountIpcHandlers({
  centralAuth,
  host,
  localProfile,
  selfHostedDesktopAccount,
  remoteServers,
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
    const account = selfHostedDesktopAccount;
    const state = () => account?.getState() ?? localProfile.getState();
    const synchronizeServers = async () => {
      if (!account?.isSignedIn || !remoteServers) return;
      await runCauseEffect(remoteServers.syncAccountDirectory()).catch(() => undefined);
    };
    return {
      auth: {
        getState: handler(state),
        retry: handler(async () => {
          const next = account ? await Effect.runPromise(account.retry()) : localProfile.getState();
          await synchronizeServers();
          return next;
        }),
        selfHostedLogin: payloadHandler(parseSelfHostedLogin, async (input) => {
          if (!account) return disabled();
          const next = await Effect.runPromise(account.signIn(input));
          await synchronizeServers();
          return next;
        }),
        selfHostedRegister: payloadHandler(parseSelfHostedRegistration, async (input) => {
          if (!account) return disabled();
          const next = await Effect.runPromise(account.register(input));
          await synchronizeServers();
          return next;
        }),
        useLocalProfile: handler(async () => {
          if (!account) return localProfile.getState();
          return Effect.runPromise(account.useLocalProfile());
        }),
        getSelfHostedServerAddress: handler(() => account?.getServerAddress() ?? ""),
        requestEmailCode: payloadHandler(stringPayload("email", INPUT_LIMITS.email), disabled),
        verifyEmailCode: payloadHandler(parseEmailCodeVerification, disabled),
        updateName: payloadHandler(parseProfileName, async (name) => {
          const next = account
            ? await Effect.runPromise(account.updateName(name))
            : await runCauseEffect(localProfile.updateName(name));
          return account?.isUsingLocalProfile === false ? next : updateLocalProfile(next);
        }),
        updateAvatar: payloadHandler(parseAvatarImage, async (parsed) => {
          const next = account
            ? await Effect.runPromise(account.updateAvatar(parsed))
            : await runCauseEffect(localProfile.updateAvatar(parsed));
          return account?.isUsingLocalProfile === false ? next : updateLocalProfile(next);
        }),
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
        logout: handler(async () => {
          if (!account) return { status: "signed_out" as const };
          return Effect.runPromise(account.logout());
        }),
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
      selfHostedLogin: payloadHandler(parseSelfHostedLogin, () => {
        throw new Error("Self-hosted account login is not enabled in this build.");
      }),
      selfHostedRegister: payloadHandler(parseSelfHostedRegistration, () => {
        throw new Error("Self-hosted account registration is not enabled in this build.");
      }),
      useLocalProfile: handler(() => centralAuth.getState()),
      getSelfHostedServerAddress: handler(() => ""),
    },
  };
}
