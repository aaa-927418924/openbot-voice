import { runCauseEffect } from "../backend/effect-boundary";
import type { TeamStore } from "./team-store";

/** Select the signed-in account's saved host or reuse an unowned host before creating one. */
export async function ensureLocalHostConfigured(
  teamStore: Pick<TeamStore, "configured" | "activateLocalHost" | "deactivate" | "configure">,
  defaultName: string,
  ownerPassword: string,
  accountId: string,
  accountEmail: string | null,
  isCurrentAccount: () => boolean = () => true,
): Promise<void> {
  const assertCurrentAccount = () => {
    if (!isCurrentAccount()) throw new Error("The signed-in account changed during local host setup.");
  };
  assertCurrentAccount();
  if (await runCauseEffect(teamStore.activateLocalHost(accountId, accountEmail))) {
    assertCurrentAccount();
    return;
  }
  assertCurrentAccount();
  if (teamStore.configured) await runCauseEffect(teamStore.deactivate());
  assertCurrentAccount();
  await runCauseEffect(teamStore.configure(defaultName, "owner", ownerPassword, accountId, isCurrentAccount));
  assertCurrentAccount();
}
