### Added

- Windows and Linux OpenBot hosts can now receive command requests from another OpenBot agent. Each target stores separate per-agent grants for command execution and optional background Computer Use; both are off by default. Android chats can use the same coordinator tools.

### Changed

- Remote commands use an explicit executable and arguments, a fixed executable path, an allowed working directory, bounded runtime and output, and target-side rules that block known high-risk operations. These controls do not provide an operating-system sandbox.
