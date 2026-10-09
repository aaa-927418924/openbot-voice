/** Normalize the app-specific URI scheme before validating a Mobile Connect URL. */
export function normalizeMobileConnectLink(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if ((url.protocol === "openbot:" || url.protocol === "openbotvoice:") && url.hostname === "mobile-connect") {
      if (url.username !== "" || url.password !== "" || url.port !== "") return "";
      return url.protocol === "openbotvoice:" ? trimmed.replace(/^openbotvoice:/iu, "openbot:") : trimmed;
    }
  } catch {
    // Preserve malformed input for the canonical parser to reject.
  }
  return trimmed;
}
