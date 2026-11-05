### Added

- Remote device command review now runs Liquid AI d1-2B only on the Linux OpenBot Cloud host. The model downloads on first use and stays unloaded after three idle minutes. Agent tools can target only computers shared for device operations; regular OpenBot servers are excluded. Catastrophic disk and system-root operations remain blocked by fixed rules on both Cloud and the target computer.

### Fixed

- Shared Windows and Linux computers can be rediscovered and authenticated after session expiry, and direct agent chats now show the Bot avatar and name in the same position as channel messages.
