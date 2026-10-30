# Self-hosted OpenBot server CLI (Linux phase)

The Linux server process is separate from the OpenBot desktop window. It owns the self-hosted identity API and reads the existing `~/.config/OpenBot/local-profile.json` and `self-hosted-identity.json`, preserving the account/profile ID. It does not open the conversation database or load message contents. Conversation history remains on each OpenBot host.

Run `bun run server:cli setup` once to set the shared email/password credentials, then `bun run server:cli install-autostart` to build and install the standalone CLI, enable the per-user systemd service, and register the tray process when an installed OpenBot launcher can be found. `bun run server:cli tui` opens the local terminal status screen. The systemd service restarts after failures. To start it before a graphical login after boot, the current Linux account needs systemd lingering enabled; the installer reports the exact `loginctl` command if that needs administrator permission.

The admin status file contains only process state, start/update timestamps, the private API URL, signed-in device name/platform/timestamps, and CPU/RAM/GPU measurements. It is written with owner-only permissions under the user's runtime/cache directory. The TUI and tray do not display email addresses, passwords, access tokens, conversation titles, message bodies, or attachments. Device rows describe unexpired sign-in sessions, not real-time network reachability.

## Threat model and limits

- The identity API listener selects the Linux host's Tailscale interface; the password login route is therefore intended for the encrypted private tailnet. Do not publish this HTTP endpoint through a public reverse proxy, Funnel, or custom public domain. Public endpoints require HTTPS and additional deployment controls before they are supported.
- Login passwords are validated and stored as scrypt hashes with random salts; bearer tokens are returned once and only their hashes are persisted. The login endpoint has an in-memory per-source rate limit. A restart clears that counter.
- The service runs as the installing Linux user, with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, and automatic restart. Its code does not access the conversation database. The Linux account owner still controls filesystem permissions for all files under that account.
- The status file is local IPC between the service, TUI, and tray. It is not served over the network. A malformed status file is rejected before rendering.
- The GUI and standalone service may run together. Only one process can bind the identity API port; the other reuses it only after a health check confirms the expected identity API is listening on this machine's Tailscale address. Both processes read and write the same account directory with file locking.
- The TUI shows account-server metadata and can hide or restore a server for all of its members. Conversation data remains on each Team host; this service does not migrate it.

The service supplies Linux account-directory administration and service recovery. Desktop and Android clients use its account-level server list while keeping each host's Team data and credentials on their own devices.
