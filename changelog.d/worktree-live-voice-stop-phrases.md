### Changed

- GPT Live can end its current call through a server-side tool after understanding a spoken end-call request, including paraphrases and minor transcription errors. A tolerant server transcript fallback covers existing threads that do not yet expose the new tool. Existing clients still receive the normal closed event and need no update.
