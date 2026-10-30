// The cloud account: email sign-in, profile, and the mobile devices connected to it.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { SelfHostedAccountLoginInput, SelfHostedAccountRegistrationInput } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { CentralAuthManager } from "../central-auth-manager";
import type { HostService } from "../host-service";
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
  selfHostedDesktopAccount?: SelfHostedDesktopAccountManager;
  remoteServers?: Pick<RemoteServerManager, "syncAccountDirectory">;
  selfHostedIdentity?: {
    authority: SelfHostedIdentityAuthority;
    api: SelfHostedIdentityApiServer;
    teamStore: TeamStore;
  };
  onSelfHostedSignIn?: () => void;
  prepareSelfHostedHost?: () => Promise<void>;
  host: Pick<HostService, "configure" | "getStatus" | "start" | "getMobileConnectHost" | "createMemberDeviceLink">;
}

export function accountIpcHandlers({
  centralAuth,
  host,
  selfHostedDesktopAccount,
  remoteServers,
  selfHostedIdentity,
  onSelfHostedSignIn,
  prepareSelfHostedHost,
}: AccountIpcDependencies): Pick<IpcGroupHandlers, "auth"> {
  if (selfHostedDesktopAccount) {
    const disabled = () => {
      throw new Error("OpenBot account services are disabled in local-only mode.");
    };
    const account = selfHostedDesktopAccount;
    const state = () => account.getState();
    const synchronizeServers = async () => {
      if (!account?.isSignedIn || !remoteServers) return;
      await runCauseEffect(remoteServers.syncAccountDirectory()).catch(() => undefined);
    };
    return {
      auth: {
        getState: handler(state),
        retry: handler(async () => {
          const next = await Effect.runPromise(account.retry());
          await synchronizeServers();
          if (next.status === "signed_in") onSelfHostedSignIn?.();
          return next;
        }),
        selfHostedLogin: payloadHandler(parseSelfHostedLogin, async (input) => {
          const next = await Effect.runPromise(account.signIn(input));
          await synchronizeServers();
          if (next.status === "signed_in") onSelfHostedSignIn?.();
          return next;
        }),
        selfHostedRegister: payloadHandler(parseSelfHostedRegistration, async (input) => {
          const next = await Effect.runPromise(account.register(input));
          await synchronizeServers();
          if (next.status === "signed_in") onSelfHostedSignIn?.();
          return next;
        }),
        useLocalProfile: handler(async () => {
          return Effect.runPromise(account.useLocalProfile());
        }),
        getSelfHostedServerAddress: handler(() => account?.getServerAddress() ?? ""),
        requestEmailCode: payloadHandler(stringPayload("email", INPUT_LIMITS.email), disabled),
        verifyEmailCode: payloadHandler(parseEmailCodeVerification, disabled),
        updateName: payloadHandler(parseProfileName, async (name) => {
          return Effect.runPromise(account.updateName(name));
        }),
        updateAvatar: payloadHandler(parseAvatarImage, async (parsed) => {
          return Effect.runPromise(account.updateAvatar(parsed));
        }),
        createMobileConnect: handler(async () => {
          if (!selfHostedIdentity) return disabled();
          await prepareSelfHostedHost?.();
          return runCauseEffect(
            createSelfHostedMobileConnect({
              authority: selfHostedIdentity.authority,
              identityApi: selfHostedIdentity.api,
              onIdentityApiReady: async (apiUrl) => {
                const state = account.getState();
                if (state?.status !== "signed_in") throw new Error("サインインしてからQRコードを作成してください。");
                const isCurrentAccount = () => {
                  const current = account.getState();
                  return current?.status === "signed_in" && current.user.id === state.user.id;
                };
                await runCauseEffect(
                  selfHostedIdentity.teamStore.syncSelfHostedOwner(
                    selfHostedTeamProfile(state.user, apiUrl),
                    isCurrentAccount,
                  ),
                );
              },
              host,
              accountId: (() => {
                const state = account.getState();
                if (state?.status !== "signed_in") throw new Error("サインインしてからQRコードを作成してください。");
                return state.user.id;
              })(),
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
