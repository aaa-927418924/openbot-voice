// The two JSON responses of `server-migration-v1` that the source and the destination client both
// read. The route codec already validated them at the host; a client still checks its own boundary,
// because a hostile or older host can answer anything.

import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import type { ServerMigrationTransferStatus } from "./server-migration-transfer";

export function decodeServerMigrationTransferStatus(value: unknown): ServerMigrationTransferStatus {
  if (!isDynamicRecord(value)) throw invalidResponse();
  const files = Array.isArray(value.files) ? value.files : null;
  if (
    typeof value.transferId !== "string" ||
    (value.state !== "receiving" && value.state !== "paused" && value.state !== "verified") ||
    typeof value.totalBytes !== "number" ||
    typeof value.receivedBytes !== "number" ||
    !files
  ) {
    throw invalidResponse();
  }
  return {
    transferId: value.transferId,
    state: value.state,
    totalBytes: value.totalBytes,
    receivedBytes: value.receivedBytes,
    files: files.map((file) => {
      if (
        !isDynamicRecord(file) ||
        typeof file.path !== "string" ||
        typeof file.bytes !== "number" ||
        typeof file.receivedBytes !== "number" ||
        typeof file.complete !== "boolean"
      ) {
        throw invalidResponse();
      }
      return {
        path: file.path,
        bytes: file.bytes,
        receivedBytes: file.receivedBytes,
        complete: file.complete,
      };
    }),
  };
}

export function decodeServerMigrationVerified(value: unknown): { transferId: string } {
  if (!isDynamicRecord(value) || typeof value.transferId !== "string") throw invalidResponse();
  return { transferId: value.transferId };
}

function invalidResponse(): Error {
  return new Error(sourceText("error.host.migrationTransferFailed"));
}
