import { type PropsWithChildren, useMemo } from "react";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { MobileLiveVoiceProvider } from "./mobile-live-voice-context";

export function LiveVoiceWorkspaceProvider({ children }: PropsWithChildren) {
  const workspace = useMobileWorkspace();
  const host = useMemo(
    () => ({
      supportsLiveVoice: workspace.supportsLiveVoice,
      startLiveVoice: workspace.startLiveVoice,
      stopLiveVoice: workspace.stopLiveVoice,
      sendLiveVoiceText: workspace.sendLiveVoiceText,
      subscribeLiveVoiceEvents: workspace.subscribeLiveVoiceEvents,
    }),
    [
      workspace.sendLiveVoiceText,
      workspace.startLiveVoice,
      workspace.stopLiveVoice,
      workspace.subscribeLiveVoiceEvents,
      workspace.supportsLiveVoice,
    ],
  );

  return (
    <MobileLiveVoiceProvider activeServerId={workspace.activeServer.id} host={host} servers={workspace.servers}>
      {children}
    </MobileLiveVoiceProvider>
  );
}
