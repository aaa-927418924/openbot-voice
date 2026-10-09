import type { LiveVoiceWireEvent } from "@openbot/contracts/team-protocol/live-voice-v1";
import type {
  LiveVoiceSendTextRequest,
  LiveVoiceStartRequest,
  LiveVoiceStartResponse,
  LiveVoiceStopRequest,
} from "./live-voice-web-controller";

export interface MobileLiveVoiceHost {
  supportsLiveVoice(serverId: string, channel: boolean): boolean;
  startLiveVoice(input: LiveVoiceStartRequest): Promise<LiveVoiceStartResponse>;
  stopLiveVoice(input: LiveVoiceStopRequest): Promise<void>;
  sendLiveVoiceText(input: LiveVoiceSendTextRequest): Promise<void>;
  subscribeLiveVoiceEvents(listener: (serverId: string, event: LiveVoiceWireEvent) => void): () => void;
}

/** A completed HTTP refusal proves that the host did not accept a realtime session lease. */
export class MobileLiveVoiceStartRejectedError extends Error {
  constructor() {
    super("Live Voice start was refused.");
    this.name = "MobileLiveVoiceStartRejectedError";
  }
}

export function isMobileLiveVoiceStartRejectedError(error: unknown): error is MobileLiveVoiceStartRejectedError {
  return error instanceof MobileLiveVoiceStartRejectedError;
}

/** The live-voice route rejects these before it can create a session lease. */
export function isDefinitiveLiveVoiceStartRefusalStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 409;
}
