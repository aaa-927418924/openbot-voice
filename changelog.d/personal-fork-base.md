### Fixed

- Disable the desktop app self-updater in fork builds. Manual checks and remote update requests report unsupported. Provider runtimes, Marketplace, and MCP keep their own network paths.
- Disable Expo OTA in fork mobile builds and remove the official EAS project link. Personal builds load only embedded code until a personal project is set in Phase 6.
- Point every Codex process at a dedicated home inside the app userData. The fork never reads or writes the shared ~/.codex, and a home that cannot be created fails loudly instead of falling back.
- Hide servers from the rail and the menu without leaving them. Hidden servers stay on this computer only and return from Settings, which stays reachable with every server hidden. The rail and menu action menus now actually receive the hide callback, so "Hide server" appears on a right-click.
- Treat text and URLs submitted during GPT Live as requests for the existing Codex tool handoff. Codex uses the exact submitted text in the same conversation without starting a duplicate ordinary turn.
- On stop, flush the final transcript and complete unfinished requests with Codex tools. Codex writes a detailed result to the normal text conversation and does not repeat work that is already complete.
