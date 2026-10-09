"use dom";

import { useEffect, useRef } from "react";
import type { MobileLiveVoiceCommand, MobileLiveVoiceCommandResult } from "../model/live-voice-command";
import { createLiveVoiceDomDiagnostic, type LiveVoiceDomDiagnosticInput } from "../model/live-voice-dom-diagnostic";
import { createLiveVoiceWebController, type LiveVoiceWebActions } from "../model/live-voice-web-controller";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void };
  }
}

interface LiveVoiceBridgeProps extends LiveVoiceWebActions {
  active: boolean;
  commands: MobileLiveVoiceCommand[];
  currentSessionId: string | null;
  onCommandResult: (result: MobileLiveVoiceCommandResult) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}

const NO_COMMANDS: MobileLiveVoiceCommand[] = [];

function postDiagnostic(input: LiveVoiceDomDiagnosticInput): void {
  const bridge = window.ReactNativeWebView;
  if (!bridge) return;
  try {
    bridge.postMessage(JSON.stringify(createLiveVoiceDomDiagnostic(input)));
  } catch {
    // Diagnostics must not interrupt a voice command if the WebView bridge is unavailable.
  }
}

export default function LiveVoiceBridge({
  active,
  commands = NO_COMMANDS,
  currentSessionId,
  onCommandResult,
  startSession,
  stopSession,
  sendText,
  onState,
  onDiagnostic,
}: LiveVoiceBridgeProps) {
  const actions = useRef({ startSession, stopSession, sendText, onState, onDiagnostic, onCommandResult });
  actions.current = { startSession, stopSession, sendText, onState, onDiagnostic, onCommandResult };
  const controllerRef = useRef<ReturnType<typeof createLiveVoiceWebController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createLiveVoiceWebController({
      startSession: (input) => actions.current.startSession(input),
      stopSession: (input) => actions.current.stopSession(input),
      sendText: (input) => actions.current.sendText(input),
      onState: (state) => actions.current.onState(state),
      onDiagnostic: (diagnostic) => actions.current.onDiagnostic?.(diagnostic) ?? Promise.resolve(),
    });
  }
  const controller = controllerRef.current;
  const processedCommandIds = useRef(new Set<string>());

  useEffect(() => {
    postDiagnostic({ stage: "dom-mounted" });
    void actions.current.onDiagnostic?.({ step: "dom-bridge", outcome: "mounted", elapsedMs: 0 });
  }, []);

  useEffect(() => {
    postDiagnostic({
      stage: "props-updated",
      active,
      hasSessionId: Boolean(currentSessionId),
      commandCount: commands.length,
      commandTypes: commands.map((command) => command.type),
    });
  }, [active, commands, currentSessionId]);

  useEffect(() => {
    const currentIds = new Set(commands.map((command) => command.id));
    for (const id of processedCommandIds.current) {
      if (!currentIds.has(id)) processedCommandIds.current.delete(id);
    }
    for (const command of commands) {
      if (processedCommandIds.current.has(command.id)) continue;
      processedCommandIds.current.add(command.id);
      if (command.type === "start") {
        postDiagnostic({
          stage: "start-command-received",
          active,
          hasSessionId: Boolean(currentSessionId),
          sessionMatches: command.origin.sessionId === currentSessionId,
        });
      }
      void actions.current.onDiagnostic?.({ step: "command", outcome: "received", elapsedMs: 0 });
      if (
        (command.type === "start" && (!active || command.origin.sessionId !== currentSessionId)) ||
        (!active && command.type !== "stop")
      ) {
        void actions.current.onCommandResult({ commandId: command.id, ok: false, error: "inactive" });
        continue;
      }
      void executeCommand(controller, command, postDiagnostic).then(
        () => actions.current.onCommandResult({ commandId: command.id, ok: true }),
        () => actions.current.onCommandResult({ commandId: command.id, ok: false, error: "failed" }),
      );
    }
    if (!active) controller.stop();
  }, [active, commands, controller, currentSessionId]);

  useEffect(
    () => () => {
      controller.dispose();
    },
    [controller],
  );

  return null;
}

async function executeCommand(
  controller: ReturnType<typeof createLiveVoiceWebController>,
  command: MobileLiveVoiceCommand,
  postDiagnostic: (input: LiveVoiceDomDiagnosticInput) => void,
): Promise<void> {
  switch (command.type) {
    case "start": {
      postDiagnostic({ stage: "controller-start-invoked" });
      try {
        await controller.start(command.origin);
      } catch (error) {
        postDiagnostic({ stage: "controller-start-threw" });
        throw error;
      }
      postDiagnostic({ stage: "controller-start-returned" });
      return;
    }
    case "stop":
      controller.stop();
      return;
    case "toggle-mute":
      controller.toggleMute();
      return;
    case "resume-audio":
      await controller.resumeAudio();
      return;
    case "send-text":
      await controller.sendText(command.text);
      return;
    case "host-event":
      controller.handleHostEvent(command.event);
      return;
  }
}
