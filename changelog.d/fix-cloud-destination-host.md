### Added

- Remote device tools now identify shared computers by their operating-system device name and OS, and keep a reachable device visible when its permission status cannot be loaded.
- Remote device discovery and sharing now write local, privacy-preserving diagnostics to `openbot.log`, including list-tool calls, candidate counts, capability and API outcomes, and share-publication stages. Keep the temporary operation diagnostics enabled until the user confirms that remote commands and Computer Use work; then restore the normal logging level and rebuild.

### Changed

- Device-only hosts now admit the authenticated device-command routes required for remote control. Temporary local diagnostics correlate the provider tool configuration, account-directory registration, selected endpoint and host-side route decision with one operation ID; they do not record chat text or command contents. Keep these diagnostics enabled until the user confirms remote commands and Computer Use work; then restore the normal logging level and rebuild.
- Remote command routes preserve their tagged host errors, so an unavailable Codex AutoReview returns the intended localized sign-in guidance instead of an unexpected server error. The Codex CLI `--approve-for-me` mode already selects the `workspace-write` sandbox; removing a conflicting explicit `--sandbox` option fixes remote command startup. Computer Use settings can now start a local Codex device-code sign-in and confirm AutoReview readiness without sending credentials or chat content to logs.

- Remote Computer Use now stops after 20 calls or four minutes in one user turn, and after two consecutive failed actions. The agent is told to summarize completed work and remaining steps when a limit is reached.

- Windows/Linux hosts now start their Tailscale API after restart when remote-device sharing is enabled, even when the regular local server is off. They also refresh the account directory with the current API address and device-only status in this mode, so Cloud does not keep requesting an old host URL.
