import type { ServerMigrationJobSnapshot } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { Button, Dialog, IconButton, RadioGroup, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { For, Match, Show, Switch } from "solid-js";
import { useServerMigration } from "./server-migration-context";

const PHASE_LABEL = {
  preparing: "server.migration.phase.preparing",
  sending: "server.migration.phase.sending",
  finalizing: "server.migration.phase.finalizing",
  completed: "server.migration.phase.completed",
  cancelled: "server.migration.phase.cancelled",
  failed: "server.migration.phase.failed",
} as const satisfies Record<ServerMigrationJobSnapshot["phase"], AppTextKey>;

/**
 * The dialog behind the local server's "Migrate to cloud" item. It shows one job at a time: choose
 * the destination, watch the transfer, and retry a failed transfer without sending the same bytes
 * again. The source keeps every file, so no step here deletes anything on this computer.
 */
export function ServerMigrationOverlay() {
  const { t, format, errorMessage } = useText();
  const migration = useServerMigration();
  const job = () => migration.job();
  const percent = () => {
    const current = job();
    if (!current || current.totalBytes <= 0) return 0;
    return Math.min(100, Math.round((current.transferredBytes / current.totalBytes) * 100));
  };

  return (
    <Dialog.Root open={migration.dialogOpen()} onOpenChange={(open) => !open && migration.closeDialog()}>
      <Dialog.Portal>
        <Dialog.Overlay class="join-server-backdrop">
          <Dialog.Content as="section" class="join-server-dialog server-migration-dialog">
            <Dialog.Title class="server-migration-title">{t("server.migration.title")}</Dialog.Title>
            <Dialog.Description class="server-migration-description">
              {t("server.migration.description")}
            </Dialog.Description>
            <Show when={job() === null}>
              <IconButton
                class="join-server-close"
                label={t("common.close")}
                tooltip={t("common.close")}
                variant="ghost"
                disabled={migration.loading()}
                onClick={() => migration.closeDialog()}
              >
                <X />
              </IconButton>
            </Show>

            <Show when={migration.error()}>
              {(cause) => (
                <p class="server-migration-error" role="alert">
                  {errorMessage(cause(), t("server.migration.startFailed"))}
                </p>
              )}
            </Show>

            <Switch>
              <Match when={job()}>
                {(current) => (
                  <div class="server-migration-progress">
                    <p class="server-migration-phase">{t(PHASE_LABEL[current().phase])}</p>
                    <Show when={current().phase === "sending" || current().phase === "finalizing"}>
                      <div
                        class="server-migration-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent()}
                      >
                        <div class="server-migration-fill" style={{ width: `${percent()}%` }} />
                      </div>
                      <p class="server-migration-bytes">
                        {t("server.migration.progress", {
                          sent: format.fileSize(current().transferredBytes),
                          total: format.fileSize(current().totalBytes),
                        })}
                      </p>
                    </Show>
                    <Show when={current().phase === "completed"}>
                      <p class="server-migration-note">{t("server.migration.completedDetail")}</p>
                    </Show>
                    <Show when={current().phase === "failed" && current().message}>
                      <p class="server-migration-error" role="alert">
                        {errorMessage(current().message, t("server.migration.startFailed"))}
                      </p>
                    </Show>
                    <Show when={current().phase === "cancelled" || current().phase === "failed"}>
                      <p class="server-migration-note">{t("server.migration.retryNote")}</p>
                    </Show>
                    <Show when={migration.running()}>
                      <p class="server-migration-note">{t("server.migration.keepData")}</p>
                    </Show>
                  </div>
                )}
              </Match>
              <Match when={!migration.loading()}>
                <Show
                  when={migration.destinations().length > 0}
                  fallback={<p class="server-migration-note">{t("server.migration.empty")}</p>}
                >
                  <p class="server-migration-legend" id="server-migration-destination-legend">
                    {t("server.migration.destination")}
                  </p>
                  <RadioGroup.Root
                    class="server-migration-destinations"
                    aria-labelledby="server-migration-destination-legend"
                    value={migration.destinationServerId() ?? undefined}
                    onChange={(value) => migration.selectDestination(value)}
                  >
                    <For each={migration.destinations()}>
                      {(destination) => (
                        <RadioGroup.Item class="server-migration-destination" value={destination.serverId}>
                          <RadioGroup.ItemInput />
                          <RadioGroup.ItemLabel>{destination.serverName}</RadioGroup.ItemLabel>
                        </RadioGroup.Item>
                      )}
                    </For>
                  </RadioGroup.Root>
                  <p class="server-migration-note">{t("server.migration.keepData")}</p>
                </Show>
              </Match>
            </Switch>

            <footer class="server-migration-actions">
              <Switch>
                <Match when={migration.running()}>
                  <Button variant="ghost" onClick={() => void migration.cancel()}>
                    {t("common.cancel")}
                  </Button>
                </Match>
                <Match when={!job()}>
                  <Button variant="ghost" onClick={() => migration.closeDialog()}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    disabled={!migration.destinationServerId() || migration.loading()}
                    onClick={() => void migration.start()}
                  >
                    {t("server.migration.start")}
                  </Button>
                </Match>
                <Match when={job()?.retryable}>
                  <Button variant="ghost" onClick={() => migration.closeDialog()}>
                    {t("common.close")}
                  </Button>
                  <Button loading={migration.loading()} onClick={() => void migration.retry()}>
                    {t("common.retry")}
                  </Button>
                </Match>
                <Match when={job()}>
                  <Button onClick={() => migration.closeDialog()}>{t("common.close")}</Button>
                </Match>
              </Switch>
            </footer>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
