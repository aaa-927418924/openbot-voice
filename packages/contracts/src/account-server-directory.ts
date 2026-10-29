import type { TeamRole } from "./ipc-team-host";

/** Public self-hosted Team host metadata shared through the account identity service. */
export interface AccountServerDirectoryEntry {
  readonly hostId: string;
  readonly name: string;
  readonly apiUrl: string;
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly logoKey: string | null;
  readonly membershipId: string;
  /** A directory hint only; permissions must be checked by the Team server. */
  readonly role: TeamRole;
  /** Reserved for a verified Team-host permission check. The sync service returns false. */
  readonly isOwner: boolean;
}

/** Device-independent fields only. Team session tokens remain in each device's secure storage. */
export type AccountServerRegistration = Omit<AccountServerDirectoryEntry, "isOwner">;
