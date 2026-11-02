### Added

- The Linux account server can now run a separate Cloud Team host with chat, channels, Live Voice, file transfer, remote desktop, and server migration.

### Fixed

- The Cloud host now stays in the background when its GUI client closes, and migration leaves the source server data intact.
- Keep the Windows/Linux Bot list at its current scroll position during periodic account-directory updates.
- Keep the verified Cloud server name and icon from being replaced by stale directory data, and stop server context menus from closing during tooltip focus changes.
- Let the Cloud host reuse OpenBot's Codex sign-in and Wayland portal consent state while keeping Cloud-specific runtime data isolated.
- Label Cloud servers across desktop and mobile, stabilize nested menus, improve custom-theme visibility, and remove Payment and Updates from app settings.
- Bound WebRTC Remote Desktop startup by the session request deadline.
