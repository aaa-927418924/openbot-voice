import type {
  AgentSummary,
  RemoteDeviceCommandPermission,
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
  Textarea,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, createStore, onCleanup, onSettled, Show } from "solid-js";
import { remoteDeviceCommandsPort } from "./remote-device-commands-port";

interface RemoteDeviceCommandsState {
  agents: AgentSummary[];
  targets: RemoteDeviceCommandTarget[];
  agentId: string;
  serverId: string;
  permission: RemoteDeviceCommandPermission | null;
  executablesText: string;
  directoriesText: string;
  loading: boolean;
  loadingPermission: boolean;
  saving: boolean;
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

function lines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function RemoteDeviceCommandsSetup() {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<RemoteDeviceCommandsState>({
    agents: [],
    targets: [],
    agentId: "",
    serverId: "",
    permission: null,
    executablesText: "",
    directoriesText: "",
    loading: true,
    loadingPermission: false,
    saving: false,
    error: null,
    notice: null,
  });
  const [selectMount, setSelectMount] = createSignal<HTMLElement>();
  let root: HTMLElement | undefined;
  let disposed = false;

  const selectedAgent = () => state.agents.find((agent) => agent.id === state.agentId) ?? null;
  const selectedTarget = () => state.targets.find((target) => target.serverId === state.serverId) ?? null;
  const patchState = (patch: Partial<RemoteDeviceCommandsState>) => setState((current) => ({ ...current, ...patch }));
  async function loadDevices(): Promise<void> {
    patchState({ loading: true, error: null });
    try {
      const [agents, targets] = await Promise.all([
        remoteDeviceCommandsPort().listAgents(),
        remoteDeviceCommandsPort().deviceCommands.listTargets(),
      ]);
      if (disposed) return;
      patchState({ agents, targets });
      setState((current) => ({
        ...current,
        agentId: agents.some((agent) => agent.id === current.agentId) ? current.agentId : (agents[0]?.id ?? ""),
        serverId: targets.some((target) => target.serverId === current.serverId && target.state === "online")
          ? current.serverId
          : (targets.find((target) => target.state === "online")?.serverId ?? ""),
      }));
    } catch (cause) {
      if (!disposed) patchState({ error: errorMessage(cause, t("computerUse.remote.error.load")) });
    } finally {
      if (!disposed) patchState({ loading: false });
    }
  }

  async function loadPermission(serverId: string, agentId: string): Promise<void> {
    patchState({ permission: null, executablesText: "", directoriesText: "", notice: null });
    if (!serverId || !agentId || selectedTarget()?.state !== "online") {
      patchState({ loadingPermission: false });
      return;
    }

    patchState({ loadingPermission: true, error: null });
    try {
      const permission = await remoteDeviceCommandsPort().deviceCommands.getPermission({ serverId, agentId });
      if (disposed || state.serverId !== serverId || state.agentId !== agentId) return;
      patchState({
        permission,
        executablesText: permission.allowedExecutables.join("\n"),
        directoriesText: permission.allowedDirectories.join("\n"),
      });
    } catch (cause) {
      if (!disposed && state.serverId === serverId && state.agentId === agentId) {
        patchState({ error: errorMessage(cause, t("computerUse.remote.error.permission")) });
      }
    } finally {
      if (!disposed && state.serverId === serverId && state.agentId === agentId)
        patchState({ loadingPermission: false });
    }
  }

  createEffect(
    () => [state.serverId, state.agentId] as const,
    ([serverId, agentId]) => void loadPermission(serverId, agentId),
  );

  async function savePermission(): Promise<void> {
    const target = selectedTarget();
    const agent = selectedAgent();
    const permission = state.permission;
    if (target?.state !== "online" || !agent || !permission || state.saving) return;
    patchState({ saving: true, error: null, notice: null });
    try {
      const saved = await remoteDeviceCommandsPort().deviceCommands.updatePermission({
        serverId: target.serverId,
        permission: {
          agentId: agent.id,
          commandsEnabled: permission.commandsEnabled,
          computerUseEnabled: permission.computerUseEnabled,
          allowedExecutables: lines(state.executablesText),
          allowedDirectories: lines(state.directoriesText),
        },
      });
      if (disposed || state.serverId !== target.serverId || state.agentId !== agent.id) return;
      patchState({
        permission: saved,
        executablesText: saved.allowedExecutables.join("\n"),
        directoriesText: saved.allowedDirectories.join("\n"),
        notice: t("computerUse.remote.saved"),
      });
    } catch (cause) {
      if (!disposed) patchState({ error: errorMessage(cause, t("computerUse.remote.error.save")) });
    } finally {
      if (!disposed) patchState({ saving: false });
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
        <Show when={!state.loading && state.error === null && state.agents.length === 0}>
          <p class="remote-device-commands-message">{t("computerUse.remote.empty.agents")}</p>
        </Show>
        <Show when={!state.loading && state.error === null && state.targets.length === 0}>
          <p class="remote-device-commands-message">{t("computerUse.remote.empty.targets")}</p>
        </Show>
        <Show when={state.agents.length > 0 && state.targets.length > 0}>
          <div class="remote-device-commands-selectors">
            <div class="remote-device-commands-select-field">
              <span>{t("computerUse.remote.agent")}</span>
              <Select<AgentSummary>
                options={state.agents}
                value={selectedAgent() ?? undefined}
                optionValue="id"
                optionTextValue="name"
                onOpenChange={onSelectOpen}
                onChange={(agent) => agent && patchState({ agentId: agent.id })}
                itemComponent={(item) => <SelectItem item={item.item}>{item.item.rawValue.name}</SelectItem>}
              >
                <SelectTrigger size="sm" aria-label={t("computerUse.remote.agent")}>
                  <SelectValue<AgentSummary>>{(option) => option.selectedOption()?.name}</SelectValue>
                </SelectTrigger>
                <SelectContent mount={selectMount()} />
              </Select>
            </div>
            <div class="remote-device-commands-select-field">
              <span>{t("computerUse.remote.device")}</span>
              <Select<RemoteDeviceCommandTarget>
                options={state.targets}
                value={selectedTarget() ?? undefined}
                optionValue="serverId"
                optionTextValue="name"
                optionDisabled={(target) => target.state !== "online"}
                onOpenChange={onSelectOpen}
                onChange={(target) => target && patchState({ serverId: target.serverId })}
                itemComponent={(item) => (
                  <SelectItem item={item.item}>
                    {item.item.rawValue.name} · {t(SERVER_STATE_KEYS[item.item.rawValue.state])}
                  </SelectItem>
                )}
              >
                <SelectTrigger size="sm" aria-label={t("computerUse.remote.device")}>
                  <SelectValue<RemoteDeviceCommandTarget>>{(option) => option.selectedOption()?.name}</SelectValue>
                </SelectTrigger>
                <SelectContent mount={selectMount()} />
              </Select>
            </div>
          </div>

          <Show when={selectedTarget()?.state !== "online"}>
            <p class="remote-device-commands-message">{t("computerUse.remote.deviceOffline")}</p>
          </Show>
          <Show when={selectedTarget()?.state === "online" && selectedTarget()?.computerUseAvailable !== true}>
            <p class="remote-device-commands-message">{t("computerUse.remote.computerUseUnavailable")}</p>
          </Show>

          <Show when={state.loadingPermission}>
            <p class="remote-device-commands-message" role="status">
              {t("computerUse.remote.loading")}
            </p>
          </Show>

          <Show when={state.permission}>
            {(permission) => (
              <>
                <ItemGroup class="settings-modal-card remote-device-commands-permissions">
                  <SwitchField
                    checked={permission().commandsEnabled}
                    disabled={state.loadingPermission || state.saving || selectedTarget()?.state !== "online"}
                    onChange={(commandsEnabled) => patchState({ permission: { ...permission(), commandsEnabled } })}
                    label={t("computerUse.remote.commands.title")}
                    description={t("computerUse.remote.commands.description")}
                  />
                  <SwitchField
                    checked={permission().computerUseEnabled}
                    disabled={
                      state.loadingPermission ||
                      state.saving ||
                      selectedTarget()?.state !== "online" ||
                      (selectedTarget()?.computerUseAvailable !== true && !permission().computerUseEnabled)
                    }
                    onChange={(computerUseEnabled) =>
                      patchState({ permission: { ...permission(), computerUseEnabled } })
                    }
                    label={t("computerUse.remote.computerUse.title")}
                    description={t("computerUse.remote.computerUse.description")}
                  />
                </ItemGroup>
                <div class="remote-device-commands-fields">
                  <label class="remote-device-commands-field">
                    <span>{t("computerUse.remote.executables.title")}</span>
                    <small>{t("computerUse.remote.executables.description")}</small>
                    <Textarea
                      rows={3}
                      value={state.executablesText}
                      disabled={state.loadingPermission || state.saving || selectedTarget()?.state !== "online"}
                      aria-label={t("computerUse.remote.executables.title")}
                      onValueChange={(value) => patchState({ executablesText: value })}
                    />
                  </label>
                  <label class="remote-device-commands-field">
                    <span>{t("computerUse.remote.directories.title")}</span>
                    <small>{t("computerUse.remote.directories.description")}</small>
                    <Textarea
                      rows={3}
                      value={state.directoriesText}
                      disabled={state.loadingPermission || state.saving || selectedTarget()?.state !== "online"}
                      aria-label={t("computerUse.remote.directories.title")}
                      onValueChange={(value) => patchState({ directoriesText: value })}
                    />
                  </label>
                </div>
                <p class="remote-device-commands-warning">{t("computerUse.remote.allowlistNotice")}</p>
                <div class="remote-device-commands-save">
                  <Button
                    type="button"
                    size="sm"
                    loading={state.saving}
                    disabled={state.loadingPermission || selectedTarget()?.state !== "online"}
                    onClick={() => void savePermission()}
                  >
                    {t("computerUse.remote.save")}
                  </Button>
                </div>
              </>
            )}
          </Show>
        </Show>
      </SettingsSection>
    </div>
  );
}
