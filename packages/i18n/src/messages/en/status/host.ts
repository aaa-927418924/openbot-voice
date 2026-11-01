import { defineMessages } from "../../../message";

export const messages = defineMessages("status.host", {
  // Status lines of the WebRTC host.
  "status.host.registered": "Registered this OpenBot for WebRTC access.",
  "status.host.identityUpdated": "Server identity updated.",
  "status.host.starting": "Starting the WebRTC host…",
  "status.host.ready": "This OpenBot is ready for WebRTC connections.",
  "status.host.stopping": "Making this OpenBot private…",
  "status.host.private": "This OpenBot is private.",
  "status.host.migrationMissingAttachments": {
    one: "Migration completed, but {count} attachment file was already missing on this computer. Its chat reference was kept, but its bytes could not be moved.",
    other:
      "Migration completed, but {count} attachment files were already missing on this computer. Their chat references were kept, but their bytes could not be moved.",
  },
});
