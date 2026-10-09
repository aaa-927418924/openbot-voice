"use dom";

import { useEffect, useRef } from "react";
import type { MobileLiveVoiceCommand, MobileLiveVoiceCommandResult } from "../model/live-voice-command";
import { createLiveVoiceWebController, type LiveVoiceWebActions } from "../model/live-voice-web-controller";

interface LiveVoiceBridgeProps extends LiveVoiceWebActions {
  active: boolean;
  commands: MobileLiveVoiceCommand[];
  currentSessionId: string | null;
  onCommandResult: (result: MobileLiveVoiceCommandResult) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}

const NO_COMMANDS: MobileLiveVoiceCommand[] = [];

export default function LiveVoiceBridge({
  active,
  commands = NO_COMMANDS,
  currentSessionId,
  onCommandResult,
  startSession,
  stopSession,
  sendText,
  onState,
}: LiveVoiceBridgeProps) {
  const actions = useRef({ startSession, stopSession, sendText, onState, onCommandResult });
  actions.current = { startSession, stopSession, sendText, onState, onCommandResult };
  const controllerRef = useRef<ReturnType<typeof createLiveVoiceWebController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createLiveVoiceWebController({
      startSession: (input) => actions.current.startSession(input),
      stopSession: (input) => actions.current.stopSession(input),
      sendText: (input) => actions.current.sendText(input),
      onState: (state) => actions.current.onState(state),
    });
  }
  const controller = controllerRef.current;
  const processedCommandIds = useRef(new Set<string>());

  useEffect(() => {
    const currentIds = new Set(commands.map((command) => command.id));
    for (const id of processedCommandIds.current) {
      if (!currentIds.has(id)) processedCommandIds.current.delete(id);
    }
    for (const command of commands) {
      if (processedCommandIds.current.has(command.id)) continue;
      processedCommandIds.current.add(command.id);
      if (
        (command.type === "start" && (!active || command.origin.sessionId !== currentSessionId)) ||
        (!active && command.type !== "stop")
      ) {
        void actions.current.onCommandResult({ commandId: command.id, ok: false, error: "inactive" });
        continue;
      }
      void executeCommand(controller, command).then(
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
): Promise<void> {
  switch (command.type) {
    case "start":
      await controller.start(command.origin);
      return;
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
