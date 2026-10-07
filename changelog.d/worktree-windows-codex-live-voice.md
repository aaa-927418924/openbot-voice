### Added

- Windows desktop users can start a subscription-backed Codex Live call from the persistent app-level voice control. The call uses Codex's experimental local app-server WebRTC path; microphone audio goes from the renderer to Codex, and finalized transcript segments are saved in the existing local conversation.
- The call stays active while you switch Bots or server views. Text submitted in the call's origin Bot goes to the active Live session, including plain URLs; other Bots keep their normal chat route.

- Windows microphone, account, and native tool handoff behavior still needs acceptance testing on Windows.

### Fixed

- A host rejection now releases a failed Live voice launch so it can be retried. Launch errors clear after five seconds; an ambiguous remote failure keeps the session reserved while hiding the expired message.
