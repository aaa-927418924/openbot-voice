### Added

- Desktop clients can sign in or register with the self-hosted identity service, switch back to a local profile, and synchronize the signed-in account’s server list. Logging out revokes the account session but preserves local profile and conversation data.

### Fixed

- Settings dialogs now close reliably with Escape and outside clicks. A Solid 2 effect error that halted the settings reactive tree is fixed.
- The server picker stays visible and clickable in compact menu layout, and a failed connection attempt returns the Retry button to an enabled state.
- First-run setup can now finish without creating a local host. Desktop clients no longer sign in with a machine-name profile; saved local hosts start only after account sign-in.
