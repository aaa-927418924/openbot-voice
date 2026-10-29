### Added

- Add self-hosted account registration and login, link QR-paired devices to the existing Team member, and derive an unset profile or host name from the running device instead of a fixed machine name.
- Let the standalone server TUI and identity API use runtime Tailscale addresses and platform-specific data paths, so the service can move to another host without a baked-in device IP.
- Store Team server directory metadata by account in the self-hosted identity service so paired devices can synchronize their server lists without sharing device-local Team session tokens.
