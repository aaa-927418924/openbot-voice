### Fixed

- Disable the desktop app self-updater in fork builds. Manual checks and remote update requests report unsupported. Provider runtimes, Marketplace, and MCP keep their own network paths.
- Disable Expo OTA in fork mobile builds and remove the official EAS project link. Personal builds load only embedded code until a personal project is set in Phase 6.
- Point every Codex process at a dedicated home inside the app userData. The fork never reads or writes the shared ~/.codex, and a home that cannot be created fails loudly instead of falling back.
- Hide servers from the rail and the menu without leaving them. Hidden servers stay on this computer only and return from Settings, which stays reachable with every server hidden.
