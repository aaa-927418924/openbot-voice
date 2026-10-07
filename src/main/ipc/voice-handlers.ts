import type { VoiceModelStatus, VoiceTranscriptionResult } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { parseVoiceTranscription } from "./voice-inputs";

/**
 * Dictation, and the local Whisper model behind it.
 *
 * This build carries no Whisper binary - `voice:prepare-runtime` is not part of it - so the whole
 * group answers with the runtime's absence rather than with a model download that would still leave
 * nothing to run. The composer's microphone has been reassigned to Live voice, which uses the
 * account's own realtime channel, and this is the boundary behind it: anything that reaches for the
 * dictation channel anyway is told why, in the words the settings screens already use.
 */
export function voiceIpcHandlers(): Pick<IpcGroupHandlers, "voice"> {
  const unavailable = <Result>(): Promise<Result> =>
    Promise.reject(new Error(sourceText("error.voice.runtimeUnavailable")));
  return {
    voice: {
      getModelStatus: handler((): Promise<VoiceModelStatus> => unavailable()),
      prepareModel: handler((): Promise<VoiceModelStatus> => unavailable()),
      transcribe: payloadHandler(parseVoiceTranscription, (): Promise<VoiceTranscriptionResult> => unavailable()),
    },
  };
}
