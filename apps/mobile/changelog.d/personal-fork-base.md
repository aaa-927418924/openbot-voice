### Added

- Start Live Voice with a Codex agent or a single-agent channel on a compatible host while the app
  is in the foreground. Backgrounding the app, switching servers, or losing the connection ends the
  voice session and microphone; the agent's ongoing work continues.
- Delete an individual message from a supported conversation for everyone after confirmation.
- Clear all messages from an agent or channel conversation after confirmation. Compatible hosts
  must support history deletion.
- Hide servers from the server drawer and restore them from Settings > Hidden servers. Hiding only
  changes this app's local list; it does not change membership or connection.
- Install OpenBot Voice beside OpenBot as a separate Android app. It accepts existing `openbot://`
  desktop pairing links and `openbotvoice://mobile-connect` return links.
- Sign in to a self-hosted OpenBot account server with its address, email, and password. The app
  remembers the server and session without saving the password, and lets signed-in users change
  the account server from Settings.

### Fixed

- OpenBot Voice now accepts both `openbot://` and `openbotvoice://` Mobile Connect QR codes in the in-app scanner.
