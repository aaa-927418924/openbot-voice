import type { LiveVoiceSendTextInput, LiveVoiceStartInput, LiveVoiceStopInput } from "@openbot/contracts/ipc";
import { isLiveVoiceSendTextInput, isLiveVoiceStartInput, isLiveVoiceStopInput } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { authorizedHandler, type IpcGroupHandlers } from "./define-ipc-group";

export interface LiveVoiceIpcDependencies {
  service: AgentService;
  getMainWindow: () => LiveVoiceWindow | null;
}

export interface LiveVoiceWindow {
  isDestroyed(): boolean;
  webContents: Pick<BrowserWindow["webContents"], "id">;
}

export function requireLiveVoiceWindowSender(senderId: number, window: LiveVoiceWindow | null): void {
  if (!window || window.isDestroyed() || senderId !== window.webContents.id)
    throw new Error(sourceText("error.liveVoice.unavailable"));
}

export function liveVoiceIpcHandlers({
  service,
  getMainWindow,
}: LiveVoiceIpcDependencies): Pick<IpcGroupHandlers, "liveVoice"> {
  const authorizeMainRenderer = (event: IpcMainInvokeEvent) =>
    requireLiveVoiceWindowSender(event.sender.id, getMainWindow());
  const decodeStart = (value: unknown): LiveVoiceStartInput => {
    if (!isLiveVoiceStartInput(value)) throw new Error(sourceText("error.liveVoice.unavailable"));
    return value;
  };
  const decodeStop = (value: unknown): LiveVoiceStopInput => {
    if (!isLiveVoiceStopInput(value)) throw new Error(sourceText("error.liveVoice.unavailable"));
    return value;
  };
  const decodeSendText = (value: unknown): LiveVoiceSendTextInput => {
    if (!isLiveVoiceSendTextInput(value)) throw new Error(sourceText("error.liveVoice.unavailable"));
    return value;
  };
  return {
    liveVoice: {
      start: authorizedHandler(authorizeMainRenderer, decodeStart, (_event, input) =>
        runCauseEffect(service.startLiveVoice(input)),
      ),
      stop: authorizedHandler(authorizeMainRenderer, decodeStop, (_event, input) =>
        runCauseEffect(service.stopLiveVoice(input)),
      ),
      sendText: authorizedHandler(authorizeMainRenderer, decodeSendText, (_event, input) =>
        runCauseEffect(service.sendLiveVoiceText(input)),
      ),
    },
  };
}
