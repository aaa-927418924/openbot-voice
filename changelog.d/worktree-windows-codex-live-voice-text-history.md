### Fixed

- Text submitted from the composer during a Codex Live call now appears in the open conversation and remains in its history. OpenBot preserves the submitted text, including URLs, and avoids a duplicate when Codex returns the matching transcript before the `appendText` request completes. The app-server protocol does not identify typed-text echoes, so a matching transcript that arrives after the request completes is retained as a separate transcript item to avoid suppressing later identical speech.
