import type {
  RemoteDeviceCommandPolicy,
  RemoteDeviceCommandTarget,
  ServerConnectionState,
} from "@openbot/contracts/ipc";
import {
  Button,
  ItemGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
  SwitchField,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, createStore, onCleanup, onSettled, Show } from "solid-js";
import { remoteDeviceCommandsPort } from "./remote-device-commands-port";

interface RemoteDeviceCommandsState {
  targets: RemoteDeviceCommandTarget[];
  serverId: string;
  policy: RemoteDeviceCommandPolicy | null;
  loading: boolean;
  loadingPolicy: boolean;
  share: { supported: boolean; enabled: boolean } | null;
  savingShare: boolean;
  savingPolicy: boolean;
  error: string | null;
  notice: string | null;
}

const SERVER_STATE_KEYS: Record<
  ServerConnectionState,
  | "server.state.online"
  | "server.state.connecting"
  | "server.state.offline"
  | "server.state.error"
  | "server.state.incompatible"
> = {
  online: "server.state.online",
  connecting: "server.state.connecting",
  offline: "server.state.offline",
  error: "server.state.error",
  incompatible: "server.state.incompatible",
};

export function RemoteDeviceCommandsSetup() {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<RemoteDeviceCommandsState>({
    targets: [],
    serverId: "",
    policy: null,
    loading: true,
    loadingPolicy: false,
    share: null,
    savingShare: false,
    savingPolicy: false,
    error: null,
    notice: null,
  });
  const [selectMount, setSelectMount] = createSignal<HTMLElement>();
  let root: HTMLElement | undefined;
  let disposed = false;

  const selectedTarget = () => state.targets.find((target) => target.serverId === state.serverId) ?? null;
  const canEditSelectedTarget = () => selectedTarget()?.isLocal === true || selectedTarget()?.state === "online";
  const patchState = (patch: Partial<RemoteDeviceCommandsState>) => setState((current) => ({ ...current, ...patch }));

  async function loadDevices(preferLocalTarget = false): Promise<void> {
    patchState({ loading: true, error: null });
    try {
      const [targets, share] = await Promise.all([
        remoteDeviceCommandsPort().deviceCommands.listTargets(),
        remoteDeviceCommandsPort().deviceCommands.getShareSettings(),
      ]);
      if (disposed) return;
      patchState({ targets, share });
      setState((current) => ({
        ...current,
        serverId:
          !preferLocalTarget &&
          targets.some(
            (target) => target.serverId === current.serverId && (target.state === "online" || target.isLocal),
          )
            ? current.serverId
            : (targets.find((target) => target.isLocal)?.serverId ??
              targets.find((target) => target.state === "online")?.serverId ??
              ""),
      }));
    } catch (cause) {
      if (!disposed) patchState({ error: errorMessage(cause, t("computerUse.remote.error.load")) });
    } finally {
      if (!disposed) patchState({ loading: false });
    }
  }

  async function loadPolicy(serverId: string): Promise<void> {
    patchState({ policy: null, notice: null });
    const target = state.targets.find((candidate) => candidate.serverId === serverId);
    if (!serverId || !target || (target.state !== "online" && !target.isLocal)) {
      patchState({ loadingPolicy: false });
      return;
    }
    patchState({ loadingPolicy: true, error: null });
    try {
      const policy = await remoteDeviceCommandsPort().deviceCommands.getPermission({ serverId });
      if (disposed || state.serverId !== serverId) return;
      patchState({ policy });
    } catch (cause) {
      if (!disposed && state.serverId === serverId) {
        patchState({ error: errorMessage(cause, t("computerUse.remote.error.permission")) });
      }
    } finally {
      if (!disposed && state.serverId === serverId) patchState({ loadingPolicy: false });
    }
  }

  createEffect(() => {
    const serverId = state.serverId;
    void loadPolicy(serverId);
  });

  async function setShareEnabled(enabled: boolean): Promise<void> {
    if (state.savingShare) return;
    patchState({ savingShare: true, error: null, notice: null });
    try {
      const share = await remoteDeviceCommandsPort().deviceCommands.setShareSettings({ enabled });
      if (disposed) return;
      patchState({ share });
      await loadDevices(enabled);
    } catch (cause) {
      if (!disposed) patchState({ error: errorMessage(cause, t("computerUse.remote.error.share")) });
    } finally {
      if (!disposed) patchState({ savingShare: false });
    }
  }

  async function updatePolicy(
    patch: Partial<Pick<RemoteDeviceCommandPolicy, "commandsEnabled" | "computerUseEnabled">>,
  ) {
    const target = selectedTarget();
    const current = state.policy;
    if (!target || !current || !canEditSelectedTarget() || state.savingPolicy) return;
    patchState({ savingPolicy: true, error: null, notice: null });
    const next = { commandsEnabled: current.commandsEnabled, computerUseEnabled: current.computerUseEnabled, ...patch };
    try {
      const policy = await remoteDeviceCommandsPort().deviceCommands.updatePermission({
        serverId: target.serverId,
        policy: next,
      });
      if (disposed || state.serverId !== target.serverId) return;
      patchState({ policy, notice: t("computerUse.remote.saved") });
    } catch (cause) {
      if (!disposed) patchState({ error: errorMessage(cause, t("computerUse.remote.error.save")) });
    } finally {
      if (!disposed) patchState({ savingPolicy: false });
    }
  }

  function onSelectOpen(open: boolean): void {
    if (!open) return;
    setSelectMount(root?.closest<HTMLElement>(".app-settings-modal-shell") ?? undefined);
  }

  onSettled(() => void loadDevices());
  onCleanup(() => {
    disposed = true;
  });

  return (
    <div
      ref={(element) => {
        root = element;
      }}
      class="computer-use-settings remote-device-commands-settings"
    >
      <SettingsSection
        title={t("computerUse.remote.title")}
        description={t("computerUse.remote.description")}
        actions={
          <Button type="button" size="sm" variant="outline" loading={state.loading} onClick={() => void loadDevices()}>
            {t("computerUse.remote.refresh")}
          </Button>
        }
      >
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

        <Show when={!state.loading && state.error === null && state.targets.length === 0}>
          <p class="remote-device-commands-message">{t("computerUse.remote.empty.targets")}</p>
        </Show>

        <Show when={state.targets.length > 0}>
          <div class="remote-device-commands-selectors">
            <div class="remote-device-commands-select-field">
              <span>{t("computerUse.remote.device")}</span>
              <Select<RemoteDeviceCommandTarget>
                options={state.targets}
                value={selectedTarget() ?? undefined}
                optionValue="serverId"
                optionTextValue="name"
                optionDisabled={(target) => !target.isLocal && target.state !== "online"}
                onOpenChange={onSelectOpen}
                onChange={(target) => target && patchState({ serverId: target.serverId })}
                itemComponent={(item) => (
                  <SelectItem item={item.item}>
                    {item.item.rawValue.isLocal
                      ? t("computerUse.remote.thisComputer", { name: item.item.rawValue.name })
                      : `${item.item.rawValue.name} · ${t(SERVER_STATE_KEYS[item.item.rawValue.state])}`}
                  </SelectItem>
                )}
              >
                <SelectTrigger size="sm" aria-label={t("computerUse.remote.device")}>
                  <SelectValue<RemoteDeviceCommandTarget>>
                    {(option) => {
                      const target = option.selectedOption();
                      return target?.isLocal
                        ? t("computerUse.remote.thisComputer", { name: target.name })
                        : target?.name;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent mount={selectMount()} />
              </Select>
            </div>
          </div>

          <Show when={selectedTarget()?.isLocal === false && selectedTarget()?.state !== "online"}>
            <p class="remote-device-commands-message">{t("computerUse.remote.deviceOffline")}</p>
          </Show>
          <Show when={selectedTarget()?.autoReviewAvailable === false}>
            <p class="remote-device-commands-message">{t("computerUse.remote.autoReviewUnavailable")}</p>
          </Show>
          <Show when={selectedTarget()?.state === "online" && selectedTarget()?.computerUseAvailable !== true}>
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
                  disabled={state.loadingPolicy || state.savingPolicy || !canEditSelectedTarget()}
                  onChange={(commandsEnabled) => void updatePolicy({ commandsEnabled })}
                  label={t("computerUse.remote.commands.title")}
                  description={t("computerUse.remote.commands.description")}
                />
                <SwitchField
                  checked={policy().computerUseEnabled}
                  disabled={
                    state.loadingPolicy ||
                    state.savingPolicy ||
                    !canEditSelectedTarget() ||
                    (selectedTarget()?.computerUseAvailable !== true && !policy().computerUseEnabled)
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
    </div>
  );
}
