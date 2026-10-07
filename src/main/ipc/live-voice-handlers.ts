import type {
  LiveVoiceSendTextInput,
  LiveVoiceStartInput,
  LiveVoiceStartOutcome,
  LiveVoiceStartResult,
  LiveVoiceStopInput,
} from "@openbot/contracts/ipc";
import {
  isLiveVoiceSendTextInput,
  isLiveVoiceStartInput,
  isLiveVoiceStartResult,
  isLiveVoiceStopInput,
} from "@openbot/contracts/ipc";
import type { TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import {
  LIVE_VOICE_CAPABILITY,
  LIVE_VOICE_ROUTES,
  LiveVoiceRefusedError,
} from "@openbot/contracts/team-protocol/live-voice-v1";
import { sourceText } from "@openbot/i18n/source";
import type { Effect } from "effect";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { AgentService } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { acceptEmpty, type ResponseDecoder } from "../remote-host-decoding";
import type { RemoteRequestInit } from "../remote-server-client";
import { RemoteRequestError } from "../remote-server-errors";
import type { RemoteWorkflowError } from "../remote-service-effects";
import { agentRequest } from "./agent-inputs";
import { authorizedHandler, type IpcGroupHandlers } from "./define-ipc-group";
import { routeToServer } from "./route-to-server";

/**
 * The host waits for Codex to answer the SDP offer, which the service allows thirty seconds for.
 * The request's own fifteen would end the call while the answer was still on its way.
 */
const START_TIMEOUT_MS = 60_000;

export interface LiveVoiceRemoteServers {
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean;
  request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init?: RemoteRequestInit,
  ): Effect.Effect<T, RemoteWorkflowError>;
}

export interface LiveVoiceIpcDependencies {
  service: Pick<AgentService, "startLiveVoice" | "stopLiveVoice" | "sendLiveVoiceText">;
  getMainWindow: () => LiveVoiceWindow | null;
  remoteServers: LiveVoiceRemoteServers;
}

export interface LiveVoiceWindow {
  isDestroyed(): boolean;
  webContents: Pick<BrowserWindow["webContents"], "id">;
}

export function requireLiveVoiceWindowSender(senderId: number, window: LiveVoiceWindow | null): void {
  if (!window || window.isDestroyed() || senderId !== window.webContents.id)
    throw new Error(sourceText("error.liveVoice.unavailable"));
}

/** The decoder twin of `isLiveVoiceStartResult`, for a remote host that is not a trusted sender. */
function decodeStartResult(value: unknown): LiveVoiceStartResult {
  if (!isLiveVoiceStartResult(value)) throw new Error("Invalid Live voice response.");
  return value;
}

function started(result: LiveVoiceStartResult): LiveVoiceStartOutcome {
  return { kind: "started", ...result };
}

function refused(message: string): LiveVoiceStartOutcome {
  return { kind: "refused", message };
}

/**
 * One Live voice channel, two backends: the agent runs on this machine, or on a host this window is
 * joined to. Either arm may be reached from any conversation, so the server the session belongs to
 * is the one the renderer names rather than the one the window happens to be showing - stop and
 * send-text must reach the machine that is holding the microphone.
 */
export function liveVoiceIpcHandlers({
  service,
  getMainWindow,
  remoteServers,
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
  /** A host that never said it knows the route would answer 404, and a sentence is kinder than that. */
  const requireRoute = (serverId: string): void => {
    if (!remoteServers.supportsCapability(serverId, LIVE_VOICE_CAPABILITY))
      throw new Error(sourceText("error.team.liveVoiceUnsupported"));
  };
  const remoteStart = (serverId: string, input: LiveVoiceStartInput): Promise<LiveVoiceStartOutcome> => {
    if (!remoteServers.supportsCapability(serverId, LIVE_VOICE_CAPABILITY))
      return Promise.resolve(refused(sourceText("error.team.liveVoiceUnsupported")));
    return runCauseEffect(
      remoteServers.request(serverId, LIVE_VOICE_ROUTES.start, decodeStartResult, {
        method: "POST",
        body: input,
        timeoutMs: START_TIMEOUT_MS,
      }),
    ).then(started, (error: unknown) => {
      if (error instanceof RemoteRequestError && error.status === 409) return refused(error.message);
      throw error;
    });
  };
  const remoteStop = (serverId: string, input: LiveVoiceStopInput): Promise<void> => {
    requireRoute(serverId);
    return runCauseEffect(
      remoteServers.request(serverId, LIVE_VOICE_ROUTES.stop, acceptEmpty, { method: "POST", body: input }),
    );
  };
  const remoteSendText = (serverId: string, input: LiveVoiceSendTextInput): Promise<void> => {
    requireRoute(serverId);
    return runCauseEffect(
      remoteServers.request(serverId, LIVE_VOICE_ROUTES.sendText, acceptEmpty, { method: "POST", body: input }),
    );
  };
  return {
    liveVoice: {
      start: authorizedHandler(authorizeMainRenderer, agentRequest(decodeStart), (_event, scoped) =>
        routeToServer(scoped.serverId, {
          local: () =>
            runCauseEffect(service.startLiveVoice(scoped.payload)).then(started, (error: unknown) => {
              if (error instanceof LiveVoiceRefusedError) return refused(error.message);
              throw error;
            }),
          remote: (serverId) => remoteStart(serverId, scoped.payload),
        }),
      ),
      stop: authorizedHandler(authorizeMainRenderer, agentRequest(decodeStop), (_event, scoped) =>
        routeToServer(scoped.serverId, {
          local: () => runCauseEffect(service.stopLiveVoice(scoped.payload)),
          remote: (serverId) => remoteStop(serverId, scoped.payload),
        }),
      ),
      sendText: authorizedHandler(authorizeMainRenderer, agentRequest(decodeSendText), (_event, scoped) =>
        routeToServer(scoped.serverId, {
          local: () => runCauseEffect(service.sendLiveVoiceText(scoped.payload)),
          remote: (serverId) => remoteSendText(serverId, scoped.payload),
        }),
      ),
    },
  };
}
