### Fixed

- Wait for the Live Voice start result before stopping after an early peer failure, so a refused start clears the call UI without sending a stop request for a session the host never accepted.
