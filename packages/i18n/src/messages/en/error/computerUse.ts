import { defineMessages } from "../../../message";

export const messages = defineMessages("error.computerUse", {
  // Computer Use driver and permission window errors.
  "error.computerUse.noAppToDrag": "This build of OpenBot has no application to drag.",
  "error.computerUse.helpWindowChanged": "The permission help window changed before the drag started.",
  "error.computerUse.noAppToShow": "This build of OpenBot has no application to show.",
  "error.computerUse.noDriver": "This computer has no Computer Use driver.",
  "error.computerUse.socketPathTooLong":
    "The Computer Use socket path is {length} characters, and this system allows {limit}.",
  "error.computerUse.socketDirectoryNotDirectory": "The Computer Use socket directory {path} is not a directory.",
  "error.computerUse.socketDirectoryOtherOwner": "The Computer Use socket directory {path} belongs to another user.",
  "error.computerUse.socketDirectoryShared": "The Computer Use socket directory {path} is open to other users.",
  "error.computerUse.socketNotReady": "It did not accept a connection in {seconds} seconds. {reason}",
  "error.computerUse.remoteDevicePermission":
    "This agent does not have permission for this operation on the target device.",
  "error.computerUse.remoteCommandBlocked":
    "AutoReview blocked this high-risk remote command. Do not retry it or try another command to bypass the block.",
  "error.computerUse.remoteCommandReviewBlocked":
    "The target PC’s local safety rules blocked this command. Do not retry it with a workaround; use an allowed read-only command or Computer Use if enabled.",
  "error.computerUse.remoteCommandInvalid": "The remote command request is invalid.",
  "error.computerUse.remoteAutoReviewUnavailable":
    "This command was refused because Codex CLI is not signed in through OpenBot or AutoReview is unavailable on the target PC.",
  "error.computerUse.remoteOperationUnavailable": "The remote device operation is unavailable.",
});
