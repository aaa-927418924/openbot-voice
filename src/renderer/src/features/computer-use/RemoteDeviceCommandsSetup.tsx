import type { RemoteDeviceCommandPolicy, RemoteDeviceCommandTarget } from "@openbot/contracts/ipc";
import { Button, ItemGroup, SettingsSection, SwitchField } from "@openbot/ui";
import { ProviderCodeLoginDialog, type ProviderCodeLoginState } from "@openbot/ui/components/ProviderCodeLoginDialog";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, onCleanup, onSettled, Show } from "solid-js";
import { appPort } from "../../app-port";
import { providersPort } from "../../providers-port";
import { remoteDeviceCommandsPort } from "./remote-device-commands-port";

interface RemoteDeviceCommandsState {
  localTarget: RemoteDeviceCommandTarget | null;
  policy: RemoteDeviceCommandPolicy | null;
  loading: boolean;
  loadingPolicy: boolean;
  share: { supported: boolean; enabled: boolean } | null;
  savingShare: boolean;
  savingPolicy: boolean;
  error: string | null;
  notice: string | null;
  codexLogin: ProviderCodeLoginState | null;
  signingInCodex: boolean;
}

export function RemoteDeviceCommandsSetup() {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<RemoteDeviceCommandsState>({
    localTarget: null,
    policy: null,
    loading: true,
    loadingPolicy: false,
    share: null,
    savingShare: false,
    savingPolicy: false,
    error: null,
    notice: null,
    codexLogin: null,
    signingInCodex: false,
  });
  let disposed = false;
  let loginPoll: number | undefined;
  let loginExpiry: number | undefined;
  let loginNoticeTimeout: number | undefined;
  let ownsCodexLogin = false;
  let codexLoginGeneration = 0;

  const canEditLocalTarget = () => state.localTarget?.isLocal === true;
  const patchState = (patch: Partial<RemoteDeviceCommandsState>) => setState((current) => ({ ...current, ...patch }));

  async function loadDevices(): Promise<void> {
    patchState({ loading: true, error: null });
    try {
      const [targets, share] = await Promise.all([
        remoteDeviceCommandsPort().deviceCommands.listTargets(),
        remoteDeviceCommandsPort().deviceCommands.getShareSettings(),
      ]);
      if (disposed) return;
      patchState({ localTarget: targets.find((target) => target.isLocal) ?? null, share });
    } catch (cause) {
      if (!disposed) patchState({ error: errorMessage(cause, t("computerUse.remote.error.load")) });
    } finally {
      if (!disposed) patchState({ loading: false });
    }
  }

  function clearCodexLoginTimers(): void {
    if (loginPoll !== undefined) window.clearInterval(loginPoll);
    if (loginExpiry !== undefined) window.clearTimeout(loginExpiry);
    if (loginNoticeTimeout !== undefined) window.clearTimeout(loginNoticeTimeout);
    loginPoll = undefined;
    loginExpiry = undefined;
    loginNoticeTimeout = undefined;
  }

  async function refreshAutoReviewStatus(): Promise<boolean> {
    const targets = await remoteDeviceCommandsPort().deviceCommands.listTargets();
    if (disposed) return false;
    const localTarget = targets.find((target) => target.isLocal) ?? null;
    patchState({ localTarget });
    return localTarget?.autoReviewAvailable === true;
  }

  function finishCodexLogin(): void {
    clearCodexLoginTimers();
    ownsCodexLogin = false;
    patchState({
      codexLogin: { phase: "verifying" },
      signingInCodex: false,
      notice: t("computerUse.remote.autoReviewReady"),
    });
    loginNoticeTimeout = window.setTimeout(() => {
      if (!disposed) patchState({ codexLogin: null });
      loginNoticeTimeout = undefined;
    }, 900);
  }

  async function checkCodexLogin(): Promise<void> {
    if (!ownsCodexLogin || state.codexLogin?.phase !== "waiting") return;
    try {
      if (await refreshAutoReviewStatus()) finishCodexLogin();
    } catch {
      // Leave the code flow open. Its expiry message is more useful than a transient status read.
    }
  }

  async function startCodexLogin(): Promise<void> {
    if (state.signingInCodex || state.codexLogin) return;
    const generation = ++codexLoginGeneration;
    clearCodexLoginTimers();
    patchState({ codexLogin: { phase: "starting" }, signingInCodex: true, error: null, notice: null });
    try {
      const started = await providersPort().startProviderCodeLogin("codex");
      if (disposed || generation !== codexLoginGeneration) {
        if (started.kind !== "connected")
          void providersPort()
            .cancelProviderCodeLogin("codex")
            .catch(() => undefined);
        return;
      }
      if (started.kind === "connected") {
        ownsCodexLogin = false;
        patchState({ codexLogin: null, signingInCodex: false });
        await loadDevices();
        return;
      }
      if (started.kind !== "code") throw new Error(t("computerUse.remote.signInUnsupported"));
      ownsCodexLogin = true;
      patchState({
        codexLogin: {
          phase: "waiting",
          userCode: started.userCode,
          verificationUrl: started.verificationUrl,
          ...(started.verificationUrlComplete === undefined
            ? {}
            : { verificationUrlComplete: started.verificationUrlComplete }),
          expiresAt: started.expiresAt,
        },
        signingInCodex: false,
      });
      loginPoll = window.setInterval(() => void checkCodexLogin(), 5_000);
      loginExpiry = window.setTimeout(
        () => {
          if (loginPoll !== undefined) window.clearInterval(loginPoll);
          loginPoll = undefined;
          ownsCodexLogin = false;
          if (!disposed) {
            patchState({ codexLogin: null, error: t("computerUse.remote.signInExpired") });
            void providersPort()
              .cancelProviderCodeLogin("codex")
              .catch(() => undefined);
          }
          loginExpiry = undefined;
        },
        Math.max(0, started.expiresAt - Date.now()),
      );
    } catch (cause) {
      if (!disposed && generation === codexLoginGeneration) {
        patchState({
          codexLogin: null,
          signingInCodex: false,
          error: errorMessage(cause, t("computerUse.remote.signInError")),
        });
      }
    }
  }

  function cancelCodexLogin(): void {
    codexLoginGeneration += 1;
    const shouldCancel = ownsCodexLogin || state.signingInCodex;
    ownsCodexLogin = false;
    clearCodexLoginTimers();
    patchState({ codexLogin: null, signingInCodex: false });
    if (shouldCancel)
      void providersPort()
        .cancelProviderCodeLogin("codex")
        .catch(() => undefined);
  }

  async function loadPolicy(serverId: string | undefined): Promise<void> {
    patchState({ policy: null, notice: null });
    const target = state.localTarget;
    if (!serverId || !target || target.serverId !== serverId || !target.isLocal) {
      patchState({ loadingPolicy: false });
      return;
    }
    patchState({ loadingPolicy: true, error: null });
    try {
      const policy = await remoteDeviceCommandsPort().deviceCommands.getPermission({ serverId });
      if (disposed || state.localTarget?.serverId !== serverId) return;
      patchState({ policy });
    } catch (cause) {
      if (!disposed && state.localTarget?.serverId === serverId) {
        patchState({ error: errorMessage(cause, t("computerUse.remote.error.permission")) });
      }
    } finally {
      if (!disposed && state.localTarget?.serverId === serverId) patchState({ loadingPolicy: false });
    }
  }

  createEffect(
    () => state.localTarget?.serverId,
    (serverId) => {
      void loadPolicy(serverId);
    },
  );

  async function setShareEnabled(enabled: boolean): Promise<void> {
    if (state.savingShare) return;
    patchState({ savingShare: true, error: null, notice: null });
    try {
      const share = await remoteDeviceCommandsPort().deviceCommands.setShareSettings({ enabled });
      if (disposed) return;
      patchState({ share });
      await loadDevices();
    } catch (cause) {
      if (!disposed) patchState({ error: errorMessage(cause, t("computerUse.remote.error.share")) });
    } finally {
      if (!disposed) patchState({ savingShare: false });
    }
  }

  async function updatePolicy(
    patch: Partial<Pick<RemoteDeviceCommandPolicy, "commandsEnabled" | "computerUseEnabled">>,
  ) {
    const target = state.localTarget;
    const current = state.policy;
    if (!target || !current || !canEditLocalTarget() || state.savingPolicy) return;
    patchState({ savingPolicy: true, error: null, notice: null });
    const next = { commandsEnabled: current.commandsEnabled, computerUseEnabled: current.computerUseEnabled, ...patch };
    try {
      const policy = await remoteDeviceCommandsPort().deviceCommands.updatePermission({
        serverId: target.serverId,
        policy: next,
      });
      if (disposed || state.localTarget?.serverId !== target.serverId) return;
      patchState({ policy, notice: t("computerUse.remote.saved") });
    } catch (cause) {
      if (!disposed) patchState({ error: errorMessage(cause, t("computerUse.remote.error.save")) });
    } finally {
      if (!disposed) patchState({ savingPolicy: false });
    }
  }

  onSettled(() => void loadDevices());
  onCleanup(() => {
    disposed = true;
    codexLoginGeneration += 1;
    const shouldCancelCodexLogin = ownsCodexLogin || state.signingInCodex;
    ownsCodexLogin = false;
    clearCodexLoginTimers();
    if (shouldCancelCodexLogin)
      void providersPort()
        .cancelProviderCodeLogin("codex")
        .catch(() => undefined);
  });

  return (
    <div class="computer-use-settings remote-device-commands-settings">
      <SettingsSection title={t("computerUse.remote.title")} description={t("computerUse.remote.description")}>
        <Show when={state.error}>
          <p class="remote-device-commands-message" role="alert">
            {state.error}
          </p>
        </Show>
        <Show when={state.notice}>
          <p class="remote-device-commands-message remote-device-commands-success" role="status">
            {state.notice}
          </p>
        </Show>

        <Show when={state.share?.supported}>
          <ItemGroup class="settings-modal-card remote-device-commands-permissions">
            <SwitchField
              checked={state.share?.enabled === true}
              disabled={state.savingShare}
              onChange={(enabled) => void setShareEnabled(enabled)}
              label={t("computerUse.remote.share.title")}
              description={t("computerUse.remote.share.description")}
            />
          </ItemGroup>
        </Show>

        <Show when={!state.loading && state.error === null && state.localTarget === null}>
          <p class="remote-device-commands-message">{t("computerUse.remote.empty.local")}</p>
        </Show>

        <Show when={state.localTarget}>
          <Show when={state.localTarget?.autoReviewAvailable !== true}>
            <p class="remote-device-commands-message">{t("computerUse.remote.autoReviewUnavailable")}</p>
          </Show>
          <Button
            type="button"
            variant="outline"
            disabled={state.signingInCodex || state.codexLogin !== null}
            onClick={() => void startCodexLogin()}
          >
            {state.signingInCodex || state.codexLogin !== null
              ? t("computerUse.remote.signingInCodex")
              : state.localTarget?.autoReviewAvailable === true
                ? t("computerUse.remote.signInCodexAgain")
                : t("computerUse.remote.signInCodex")}
          </Button>
          <Show when={state.localTarget?.computerUseAvailable !== true}>
            <p class="remote-device-commands-message">{t("computerUse.remote.computerUseUnavailable")}</p>
          </Show>
          <Show when={state.loadingPolicy}>
            <p class="remote-device-commands-message" role="status">
              {t("computerUse.remote.loading")}
            </p>
          </Show>
          <Show when={state.policy}>
            {(policy) => (
              <ItemGroup class="settings-modal-card remote-device-commands-permissions">
                <SwitchField
                  checked={policy().commandsEnabled}
                  disabled={state.loadingPolicy || state.savingPolicy || !canEditLocalTarget()}
                  onChange={(commandsEnabled) => void updatePolicy({ commandsEnabled })}
                  label={t("computerUse.remote.commands.title")}
                  description={t("computerUse.remote.commands.description")}
                />
                <SwitchField
                  checked={policy().computerUseEnabled}
                  disabled={
                    state.loadingPolicy ||
                    state.savingPolicy ||
                    !canEditLocalTarget() ||
                    (state.localTarget?.computerUseAvailable !== true && !policy().computerUseEnabled)
                  }
                  onChange={(computerUseEnabled) => void updatePolicy({ computerUseEnabled })}
                  label={t("computerUse.remote.computerUse.title")}
                  description={t("computerUse.remote.computerUse.description")}
                />
              </ItemGroup>
            )}
          </Show>
        </Show>
      </SettingsSection>
      <Show when={state.codexLogin}>
        {(login) => (
          <ProviderCodeLoginDialog
            open={true}
            providerName="Codex CLI"
            state={login()}
            onOpenVerificationUrl={(url) => void appPort().openUrl(url)}
            onCancel={cancelCodexLogin}
          />
        )}
      </Show>
    </div>
  );
}
