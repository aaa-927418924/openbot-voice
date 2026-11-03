import { defineMessages } from "../../message";

export const messages = defineMessages("computerUse", {
  // Computer Use settings, the permission help window, and the window highlight.
  "computerUse.permission.screenRecording.title": "Screen Recording",
  "computerUse.permission.screenRecording.description": "Lets OpenBot see app windows.",
  "computerUse.permission.screenRecording.pane": "Screen & System Audio Recording",
  "computerUse.permission.accessibility.title": "Accessibility",
  "computerUse.permission.accessibility.description": "Lets OpenBot click and type.",
  "computerUse.permission.accessibility.pane": "Accessibility",
  "computerUse.error.check": "OpenBot could not check Computer Use.",
  "computerUse.error.openSettings": "OpenBot could not open System Settings.",
  "computerUse.error.startDriver": "OpenBot could not start the Computer Use driver.",
  "computerUse.checkAgain": "Check again",
  "computerUse.checking": "Checking Computer Use",
  "computerUse.unavailable.title": "Computer Use isn’t available yet",
  "computerUse.permissions.title": "System permissions",
  "computerUse.permissions.description": "Permissions are managed by macOS.",
  "computerUse.ready.title": "Computer Use is ready",
  "computerUse.ready.description":
    "OpenBot can see and interact with apps on this computer. This system asks for no extra permission.",
  "computerUse.openSettingsFailed.title": "Couldn’t open System Settings",
  "computerUse.compact.title": "Enable Computer Use",
  "computerUse.compact.description": "Let OpenBot see and interact with apps on this computer.",
  "computerUse.granted": "Granted",
  "computerUse.opening": "Opening…",
  "computerUse.manage": "Manage",
  "computerUse.grant": "Grant",
  "computerUse.manageLabel": "Manage {permission}",
  "computerUse.grantLabel": "Grant {permission}",
  "computerUse.help.title": "Turn on {permission}",
  "computerUse.help.paneOpen": "System Settings is open at {pane}.",
  "computerUse.help.dragLabel": "Drag {name} into System Settings, or press to show it in Finder",
  "computerUse.help.dragToAdd": "Drag to add",
  "computerUse.help.findInList": "Find {name} in the list.",
  "computerUse.help.dragIntoList": "Drag {name}.app into the list.",
  "computerUse.help.turnOn": "Turn the switch on.",
  "computerUse.help.showInFinder": "Show in Finder",
  "computerUse.help.revealFailed": "The application could not be shown in Finder.",
  "computerUse.help.dragFailed": "The application could not be dragged.",
  "computerUse.highlight.working": "OpenBot is working in {title}",
  "computerUse.remote.title": "Other devices",
  "computerUse.remote.description":
    "Permissions are stored on the target device. To let a Cloud agent operate a Windows or Linux PC, enable that PC’s local server, share it with the same account, and choose This computer as the target.",
  "computerUse.remote.refresh": "Refresh devices",
  "computerUse.remote.agent": "Agent",
  "computerUse.remote.device": "Target device",
  "computerUse.remote.empty.agents": "This server has no agents yet.",
  "computerUse.remote.empty.targets":
    "No target devices are available. Enable the local OpenBot server on the target PC and share it with the same account.",
  "computerUse.remote.thisComputer": "This computer ({name})",
  "computerUse.remote.localServer.title": "Share this PC with other devices on this account",
  "computerUse.remote.localServer.description":
    "Turn this on to start this PC’s local OpenBot server and share it with the signed-in account. Keep it on while Cloud agents need to operate this PC.",
  "computerUse.remote.localServer.reconnect": "Refresh sharing",
  "computerUse.remote.localServer.disabledNotice":
    "You can save permissions on this PC, but other devices cannot see it until sharing is on.",
  "computerUse.remote.error.localServer":
    "OpenBot could not share this PC. Check account sign-in and connection status.",
  "computerUse.remote.deviceOffline": "Connect the target device to edit its permissions.",
  "computerUse.remote.computerUseUnavailable": "Computer Use is not ready on this target device.",
  "computerUse.remote.loading": "Loading this agent’s permissions…",
  "computerUse.remote.commands.title": "Allow command execution",
  "computerUse.remote.commands.description":
    "Let this agent run approved programs on the target device. A rule-based AutoReview on the target blocks known high-risk commands before they start.",
  "computerUse.remote.computerUse.title": "Allow Computer Use",
  "computerUse.remote.computerUse.description":
    "Let this agent use the target device’s screen tools. This is separate from command execution.",
  "computerUse.remote.executables.title": "Allowed executable names",
  "computerUse.remote.executables.description":
    "Enter one exact executable name per line. OpenBot resolves and fixes its path on the target when you save. Leave empty to allow no command.",
  "computerUse.remote.directories.title": "Allowed working directories",
  "computerUse.remote.directories.description":
    "Enter one target-device directory per line. Leave empty to allow no command.",
  "computerUse.remote.allowlistNotice":
    "These lists add an OpenBot permission check. They do not isolate a program from the rest of the target device.",
  "computerUse.remote.save": "Save permissions",
  "computerUse.remote.saved": "Permissions saved on the target device.",
  "computerUse.remote.error.load": "OpenBot could not load remote devices.",
  "computerUse.remote.error.permission": "OpenBot could not read this target’s permissions.",
  "computerUse.remote.error.save": "OpenBot could not save permissions on the target device.",
});
