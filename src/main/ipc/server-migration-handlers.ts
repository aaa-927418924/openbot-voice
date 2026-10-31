// Local-to-server migration. The source computer lists the servers it can send to, starts one job,
// and can cancel or retry it. A server-mode host is only ever the destination of this flow, so it
// has no source service and every call here is refused.

import type { ServerMigrationDestination, ServerMigrationJobSnapshot } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import type { ServerMigrationSourceService } from "../server-migration-source";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { stringPayload } from "./validation";

export interface ServerMigrationIpcDependencies {
  serverMigration: ServerMigrationSourceService | null;
}

export function serverMigrationIpcHandlers({
  serverMigration,
}: ServerMigrationIpcDependencies): Pick<IpcGroupHandlers, "serverMigration"> {
  const required = (): ServerMigrationSourceService => {
    if (!serverMigration) throw new Error(sourceText("error.host.migrationUnsupported"));
    return serverMigration;
  };
  return {
    serverMigration: {
      // The list is empty rather than an error, so the menu and the dialog open on a build that
      // cannot be a source and explain that there is nothing to send to.
      destinations: handler((): ServerMigrationDestination[] => serverMigration?.destinations() ?? []),
      state: handler((): ServerMigrationJobSnapshot | null => serverMigration?.state() ?? null),
      start: payloadHandler(stringPayload("serverId"), (serverId) => {
        required().start(serverId);
      }),
      cancel: payloadHandler(stringPayload("jobId"), (jobId) => {
        required().cancel(jobId);
      }),
      retry: payloadHandler(stringPayload("jobId"), (jobId) => {
        required().retry(jobId);
      }),
    },
  };
}
