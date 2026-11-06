# Global agent instructions

The Linux TUI Cloud host can load one administrator-managed `AGENTS.md` for every OpenBot agent
and channel task. Windows, Linux desktop, Android, and iOS clients do not read or store this file.

Place the file at:

```text
$OPENBOT_DATA_ROOT/AGENTS.md
```

If `OPENBOT_DATA_ROOT` is not set, the default path is `~/OpenBot/AGENTS.md` (for example,
`/home/aaa/OpenBot/AGENTS.md`). The host reads a UTF-8 regular file up to 64 KiB. It rejects
symbolic links. If the file is missing or empty, no global instructions are added.

The server injects its contents as persistent developer instructions for every agent and channel
provider session. Saving or removing the file refreshes idle sessions. A running turn finishes with
the instructions it started with; the updated file applies to the next turn. Bots cannot edit this
file through their workspace-only filesystem access because it is outside both `Agents/<id>` and
`Shared`.

These instructions take precedence over Bot profiles, memories, workspace files, attachments, tool
output, and user requests when they conflict. System, platform, and provider safety requirements
remain higher priority. This is an instruction to the model, not a mechanical authorization rule,
so actions that require hard enforcement still need server-side checks.

The file stays on the Cloud host. Its contents are included in requests to the provider selected by
each Bot; review the file for private information before adding it.
