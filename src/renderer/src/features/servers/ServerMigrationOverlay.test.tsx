import type { ServerMigrationJobSnapshot } from "@openbot/contracts/ipc";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { onSettled } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { installOpenbotStub } from "../../app-test-harness";
import { ServerMigrationOverlay } from "./ServerMigrationOverlay";
import { ServerMigrationProvider, useServerMigration } from "./server-migration-context";

const failedJob: ServerMigrationJobSnapshot = {
  jobId: "migration-1",
  destinationServerId: "cloud",
  destinationName: "Cloud",
  phase: "failed",
  transferredBytes: 4096,
  totalBytes: 8192,
  message: "The test destination rejected the final snapshot.",
  retryable: true,
};

function OpenFailedMigration() {
  const migration = useServerMigration();
  onSettled(() => void migration.openDialog());
  return <ServerMigrationOverlay />;
}

describe("ServerMigrationOverlay", () => {
  it("shows the safe migration failure reason next to the resume instructions", async () => {
    installOpenbotStub();
    vi.mocked(window.openbot.serverMigration.destinations).mockResolvedValue([
      { serverId: "cloud", serverName: "Cloud" },
    ]);
    vi.mocked(window.openbot.serverMigration.state).mockResolvedValue(failedJob);

    render(() => (
      <ServerMigrationProvider>
        <OpenFailedMigration />
      </ServerMigrationProvider>
    ));

    expect(await screen.findByRole("alert")).toHaveTextContent(failedJob.message ?? "");
    expect(
      screen.getByText("The destination keeps the bytes that arrived, so a retry sends only the rest."),
    ).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(window.openbot.serverMigration.retry).toHaveBeenCalledExactlyOnceWith(failedJob.jobId);
  });
});
