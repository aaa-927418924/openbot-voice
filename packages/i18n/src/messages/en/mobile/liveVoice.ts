import { defineMessages } from "../../../message";

export const messages = defineMessages("mobile.liveVoice", {
  "mobile.liveVoice.start": "Start Live Voice",
  "mobile.liveVoice.stop": "End Live Voice",
  "mobile.liveVoice.mute": "Mute microphone",
  "mobile.liveVoice.unmute": "Unmute microphone",
  "mobile.liveVoice.resumeAudio": "Resume audio",
  "mobile.liveVoice.microphoneActivity": "Microphone audio level",
  "mobile.liveVoice.playbackActivity": "Assistant audio level",
  "mobile.liveVoice.elapsed": "Call duration {time}",
  "mobile.liveVoice.status.connecting": "Connecting to Live Voice…",
  "mobile.liveVoice.status.live": "Live Voice active",
  "mobile.liveVoice.status.stopping": "Ending Live Voice…",
  "mobile.liveVoice.status.cleanupNeeded": "The host still has an active voice session. Try ending it again.",
  "mobile.liveVoice.status.ended": "Live Voice ended",
  "mobile.liveVoice.error.microphone": "Microphone access is unavailable. Check app permissions.",
  "mobile.liveVoice.error.unavailable": "Live Voice is unavailable. Check the connection and try again.",
  "mobile.liveVoice.error.stop": "Could not end Live Voice. The host session may still be active.",
  "mobile.liveVoice.error.send": "Could not send text to Live Voice. Your draft was restored.",
  "mobile.liveVoice.error.textOnly": "Live Voice accepts text only. Remove attachments and reply mode to send.",
  "mobile.liveVoice.history.started": "Live Voice started",
  "mobile.liveVoice.history.ended": "Live Voice ended · {time}",
});
