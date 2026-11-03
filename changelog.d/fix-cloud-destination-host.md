### Added

- Windows and Linux OpenBot hosts can now receive command requests from another OpenBot agent. Each target stores separate per-agent grants for command execution and optional background Computer Use; both are off by default. Android chats can use the same coordinator tools.

### Changed

- Remote commands use an explicit executable and arguments, a fixed executable path, an allowed working directory, bounded runtime and output, and target-side rules that block known high-risk operations. These controls do not provide an operating-system sandbox.
- An unconfigured target now reports its default-deny grants instead of disappearing from discovery. Members may use an agent's existing grant, while only admins can change grants. AutoReview also blocks destructive sync and mirror options such as `rsync --delete`, `robocopy /MIR`, and `rclone sync`.
- Compatibility and transport decoding now allow the full advertised capability list as optional Team API features grow beyond 64 entries.
