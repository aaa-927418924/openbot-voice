import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { supportLog } from "@/features/support/model/support-log";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { useAppForeground } from "@/shared/lib/use-app-foreground";
import {
  consumeWakeWordDetection,
  getWakeWordStatus,
  resumeWakeWordCapture,
} from "../model/live-voice-background-service";
import { useMobileLiveVoice } from "./mobile-live-voice-context";

/** Bridges a local wake-word event to the existing agent chat and Live Voice flow. */
export function WakeWordLiveVoiceController() {
  const foreground = useAppForeground();
  const workspace = useMobileWorkspace();
  const liveVoice = useMobileLiveVoice();
  const busy = useRef(false);

  useEffect(() => {
    if (Platform.OS !== "android" || !foreground) return;
    let mounted = true;
    const poll = async () => {
      if (!mounted || busy.current) return;
      busy.current = true;
      let resumeListener = false;
      try {
        const detection = await consumeWakeWordDetection();
        if (!detection) {
          if (liveVoice.state.phase === "idle") {
            const status = await getWakeWordStatus();
            if (status.armed && !status.listening) await resumeWakeWordCapture();
          }
          return;
        }
        if (!detection.agentId || !detection.serverId) {
          resumeListener = true;
          return;
        }

        const server = workspace.servers.find((item) => item.id === detection.serverId);
        const agent = workspace.agents.find(
          (item) => item.id === detection.agentId && item.serverId === detection.serverId,
        );
        if (!server || !agent) {
          supportLog.add("warn", "connection", "Wake word detected, but its Bot is not available for Live Voice");
          resumeListener = true;
          return;
        }
        if (server.state !== "online" || agent.provider !== "codex" || !workspace.supportsLiveVoice(server.id, false)) {
          supportLog.add("warn", "connection", "Wake word detected, but its Bot is not available for Live Voice");
          resumeListener = true;
          return;
        }

        const conversation = await workspace.loadConversation(agent.id, server.id);
        const threadId = conversation.threadId ?? agent.threadId;
        if (!threadId) {
          supportLog.add("warn", "connection", "Wake word detected, but the Bot has no Live Voice thread yet");
          resumeListener = true;
          return;
        }

        const target = {
          serverId: server.id,
          agentId: agent.id,
          threadId,
          agentName: agent.name,
          avatarSeed: agent.avatarSeed,
          avatarHue: agent.avatarHue,
        };
        workspace.selectServer(server.id);
        router.dismissAll();
        router.push({ pathname: "/chat/[agentId]", params: { agentId: agent.id } });
        if (liveVoice.canStart(target)) liveVoice.start(target);
        else {
          supportLog.add("warn", "connection", "Wake word detected, but Live Voice could not start in this app state");
          resumeListener = true;
        }
      } catch {
        supportLog.add("warn", "connection", "Wake-word handoff to Live Voice failed");
        resumeListener = true;
      } finally {
        if (resumeListener) {
          void resumeWakeWordCapture().catch(() => {
            supportLog.add("warn", "connection", "Android wake-word listener could not resume after a failed handoff");
          });
        }
        busy.current = false;
      }
    };

    const timer = setInterval(() => void poll(), 750);
    void poll();
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [foreground, liveVoice, workspace]);

  return null;
}
