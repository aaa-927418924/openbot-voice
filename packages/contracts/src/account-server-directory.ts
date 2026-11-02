import type { TeamRole } from "./ipc-team-host";

export interface AccountServerVisibilityProof {
  readonly hostId: string;
  readonly visible: boolean;
  readonly nonce: string;
  readonly signature: string;
}

/** The host signs this exact message only after confirming the account is its owner. */
export function accountServerVisibilityPayload(
  accountId: string,
  proof: Pick<AccountServerVisibilityProof, "hostId" | "visible" | "nonce">,
  registration?: Pick<
    AccountServerRegistration,
    "hostId" | "name" | "apiUrl" | "fingerprint" | "publicKey" | "logoKey" | "membershipId"
  >,
): string {
  const visibility = `OpenBot account server visibility v1\n${accountId}\n${proof.hostId}\n${proof.visible ? "visible" : "hidden"}\n${proof.nonce}`;
  if (!registration) return visibility;
  return `${visibility}\nregistration-v1\n${JSON.stringify([
    registration.hostId,
    registration.name,
    registration.apiUrl,
    registration.fingerprint,
    registration.publicKey,
    registration.logoKey,
    registration.membershipId,
  ])}`;
}

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
  /** True only when the identity host has verified that this account owns this host. */
  readonly isOwner: boolean;
  /** Set by the host's local account directory when it is running as the OpenBot Cloud host. */
  readonly origin?: "cloud";
}

/** Device-independent fields only. Team session tokens remain in each device's secure storage. */
export type AccountServerRegistration = Omit<AccountServerDirectoryEntry, "isOwner"> & {
  /** Internal migration hint; never confers access and is not returned by the directory. */
  readonly legacyImport?: boolean;
  /** Set only after an explicit invite/QR pairing to clear this account's leave tombstone. */
  readonly rejoin?: boolean;
};
