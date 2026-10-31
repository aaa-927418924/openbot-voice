import type { ServerMigrationDestination, ServerMigrationJobSnapshot } from "@openbot/contracts/ipc";
import { createSignal, onSettled } from "solid-js";
import { createSimpleContext } from "../../simple-context";

/** A phase that no longer changes by itself. The dialog can close and the job can start again. */
const FINISHED_PHASES: ReadonlySet<ServerMigrationJobSnapshot["phase"]> = new Set(["completed", "cancelled", "failed"]);

/**
 * The one local-to-server migration this computer can run as its source. The main process owns the
 * job and its snapshot; this context only holds what the dialog shows and the choices the user made.
 *
 * The destination list is read every time the dialog opens, because a joined server can come online
 * or leave while OpenBot runs. The job survives closing the dialog: progress keeps arriving, and the
 * same job is shown when the dialog opens again.
 */
const ServerMigration = createSimpleContext({
  name: "ServerMigration",
  init: () => {
    const calls = window.openbot.serverMigration;
    const [dialogOpen, setDialogOpen] = createSignal(false);
    const [destinations, setDestinations] = createSignal<ServerMigrationDestination[]>([]);
    const [destinationServerId, setDestinationServerId] = createSignal<string | null>(null);
    const [job, setJob] = createSignal<ServerMigrationJobSnapshot | null>(null);
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal<unknown>(null);

    onSettled(() => calls.onProgress((snapshot) => setJob(snapshot)));

    const running = () => {
      const current = job();
      return current !== null && !FINISHED_PHASES.has(current.phase);
    };

    async function openDialog(): Promise<void> {
      setDialogOpen(true);
      setError(null);
      setLoading(true);
      try {
        const [list, current] = await Promise.all([calls.destinations(), calls.state()]);
        setDestinations(list);
        setJob(current);
        // Keep a destination the user chose before a failed attempt, and otherwise follow the job
        // that already exists. With neither, the first destination is the default.
        const remembered = current?.destinationServerId ?? destinationServerId();
        const selected = list.some((item) => item.serverId === remembered) ? remembered : (list[0]?.serverId ?? null);
        setDestinationServerId(selected);
      } catch (cause) {
        setError(cause);
      } finally {
        setLoading(false);
      }
    }

    function closeDialog(): void {
      if (running()) return;
      setDialogOpen(false);
    }

    async function start(): Promise<void> {
      const serverId = destinationServerId();
      if (!serverId || running()) return;
      setError(null);
      setLoading(true);
      try {
        await calls.start(serverId);
        setJob(await calls.state());
      } catch (cause) {
        setError(cause);
      } finally {
        setLoading(false);
      }
    }

    async function cancel(): Promise<void> {
      const current = job();
      if (!current || !running()) return;
      setError(null);
      try {
        await calls.cancel(current.jobId);
        setJob(await calls.state());
      } catch (cause) {
        setError(cause);
      }
    }

    async function retry(): Promise<void> {
      const current = job();
      if (!current || running() || !current.retryable) return;
      setError(null);
      setLoading(true);
      try {
        await calls.retry(current.jobId);
        setJob(await calls.state());
      } catch (cause) {
        setError(cause);
      } finally {
        setLoading(false);
      }
    }

    return {
      dialogOpen,
      openDialog,
      closeDialog,
      destinations,
      destinationServerId,
      selectDestination: setDestinationServerId,
      job,
      loading,
      error,
      running,
      start,
      cancel,
      retry,
    };
  },
});

export const ServerMigrationProvider = ServerMigration.provider;
export const useServerMigration = ServerMigration.use;
