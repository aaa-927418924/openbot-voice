import type { SelfHostedAccountServerDirectory } from "./self-hosted-account-server-directory";

/** The signed-in account directory is authoritative; this device-local file is only a mirror. */
export async function mirrorLocalServerVisibility(
  directory: Pick<SelfHostedAccountServerDirectory, "setServerVisible"> | null,
  hostId: string | undefined,
  visible: boolean,
  onFailure: (error: unknown) => void,
): Promise<void> {
  if (!directory || !hostId) return;
  try {
    await directory.setServerVisible(hostId, visible);
  } catch (error) {
    onFailure(error);
  }
}
