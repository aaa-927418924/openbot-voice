### Fixed

- Live Voice startup no longer cancels a host request before the host's request deadline. Concurrent cleanup now shares one Codex stop request.
- Custom desktop themes can set an accent tint for translucent surfaces. The title bar uses the same tint and strength as the workspace header.
- Windows and Linux window controls now use the custom theme's titlebar tint and a contrasting symbol color.
- Live Voice startup errors before SDP acceptance now clean up the unstarted session instead of failing a second time during stop. Support logs record safe failure stages, categories, and HTTP refusal codes.
