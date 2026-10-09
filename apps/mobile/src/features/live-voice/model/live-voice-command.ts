import type { LiveVoiceWireEvent } from "@openbot/contracts/team-protocol/live-voice-v1";
import type { MobileLiveVoiceOrigin } from "./live-voice";

export type MobileLiveVoiceCommand =
  | { id: string; type: "start"; origin: MobileLiveVoiceOrigin }
  | { id: string; type: "stop" }
  | { id: string; type: "toggle-mute" }
  | { id: string; type: "resume-audio" }
  | { id: string; type: "send-text"; text: string }
  | { id: string; type: "host-event"; event: LiveVoiceWireEvent };

export interface MobileLiveVoiceCommandResult {
  commandId: string;
  ok: boolean;
  error?: string;
}

export function createMobileLiveVoiceCommandMailbox(publish: (commands: MobileLiveVoiceCommand[]) => void) {
  const pending = new Map<
    string,
    { command: MobileLiveVoiceCommand; resolve: (result: MobileLiveVoiceCommandResult) => void }
  >();
  let disposed = false;
  const flush = () => publish([...pending.values()].map((entry) => entry.command));

  return {
    send(command: MobileLiveVoiceCommand): Promise<MobileLiveVoiceCommandResult> {
      if (disposed) return Promise.resolve({ commandId: command.id, ok: false, error: "disposed" });
      return new Promise((resolve) => {
        pending.set(command.id, { command, resolve });
        flush();
      });
    },
    receive(result: MobileLiveVoiceCommandResult) {
      const entry = pending.get(result.commandId);
      if (!entry) return;
      pending.delete(result.commandId);
      entry.resolve(result);
      flush();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [commandId, entry] of pending) entry.resolve({ commandId, ok: false, error: "disposed" });
      pending.clear();
    },
  };
}
