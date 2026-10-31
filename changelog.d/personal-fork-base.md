### Fixed

- Restore the signed-in account's local host and keep its directory metadata current after host setup and profile changes. Start the Linux server tray in the active graphical session and open its management screen with one click. Full local-to-Linux data migration still needs a destination Team data service that can receive and verify the complete host data set.
- Keep the saved active account aligned when local server setup finishes after an account switch, while preserving the host created by the previous account.
- Re-read the latest sign-in after each delayed local-host selection write, so rapid account changes or a temporary save failure do not leave another account stuck behind a stale selection.
- Reuse the healthy local identity API when the GUI and Linux server service start together, and let the Linux service verify ownership before it refreshes the shared server directory.
- Keep account-listed servers visible as offline while their host cannot be authenticated, retry when credentials become available, and let Android apply a successful empty account list even if optional legacy-import checks fail.
- Redeem a self-hosted account ticket first, then accept a legacy host-local ticket when the account authority does not recognize it; do not hide account-session or transport errors with a fallback.
- Persist short account-ticket 401 retry cooldowns across restarts, while keeping the longer host 429 cooldown and preventing stale concurrent failures from undoing a newer session.
- Scope account-ticket failures to the account and sign-in attempt that created them, and ignore stale legacy-adoption responses after a newer session is installed.
