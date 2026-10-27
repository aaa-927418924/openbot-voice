// The cloud account: email sign-in, profile, and the mobile devices connected to it.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { CentralAuthManager } from "../central-auth-manager";
import type { HostService } from "../host-service";
import type { LocalProfileStore } from "../local-profile-store";
import { createHostedMobileConnect } from "../mobile-connect-host";
import { parseEmailCodeVerification, parseProfileName } from "./app-inputs";
import { parseAvatarImage } from "./avatar-inputs";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { stringPayload } from "./validation";

export interface AccountIpcDependencies {
  centralAuth: CentralAuthManager;
  localProfile?: LocalProfileStore;
  host: Pick<HostService, "configure" | "getStatus" | "start" | "getMobileConnectHost">;
}

export function accountIpcHandlers({
  centralAuth,
  host,
  localProfile,
}: AccountIpcDependencies): Pick<IpcGroupHandlers, "auth"> {
  if (localProfile) {
    const disabled = () => {
      throw new Error("OpenBot account services are disabled in local-only mode.");
    };
    return {
      auth: {
        getState: handler(() => localProfile.getState()),
        retry: handler(() => localProfile.getState()),
        requestEmailCode: payloadHandler(stringPayload("email", INPUT_LIMITS.email), disabled),
        verifyEmailCode: payloadHandler(parseEmailCodeVerification, disabled),
        updateName: payloadHandler(parseProfileName, (name) => runCauseEffect(localProfile.updateName(name))),
        updateAvatar: payloadHandler(parseAvatarImage, (parsed) => runCauseEffect(localProfile.updateAvatar(parsed))),
        createMobileConnect: handler(disabled),
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
