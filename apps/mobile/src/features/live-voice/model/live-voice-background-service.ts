import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

interface LiveVoiceBackgroundServiceModule {
  start(agentId: string, serverId: string, agentName: string, avatarHue: number | null): Promise<void>;
  stop(): Promise<void>;
  setWakeWordTarget(serverId: string, agentId: string, agentName: string, avatarHue: number | null): Promise<void>;
  getWakeWordStatus(): Promise<WakeWordStatus>;
  startWakeWord(): Promise<void>;
  stopWakeWord(): Promise<void>;
  pauseWakeWord(): Promise<void>;
  resumeWakeWord(): Promise<void>;
  consumeWakeWordDetection(): Promise<WakeWordDetection | null>;
  consumePendingVoiceEndAction(): Promise<boolean>;
}

export interface WakeWordStatus {
  armed: boolean;
  listening: boolean;
  starting: boolean;
  serverId: string | null;
  agentId: string | null;
  agentName: string | null;
  avatarHue: number | null;
}

export interface WakeWordDetection {
  detectedAt: number;
  serverId: string | null;
  agentId: string | null;
}

let androidModule: LiveVoiceBackgroundServiceModule | null | undefined;

function getAndroidModule(): LiveVoiceBackgroundServiceModule | null {
  if (Platform.OS !== "android") return null;
  if (androidModule === undefined) {
    androidModule = requireOptionalNativeModule<LiveVoiceBackgroundServiceModule>("OpenBotLiveVoiceBackground");
  }
  return androidModule;
}

export function isLiveVoiceBackgroundServiceAvailable(): boolean {
  return getAndroidModule() !== null;
}

export async function startLiveVoiceBackgroundService(target: {
  agentId: string;
  serverId: string;
  agentName: string;
  avatarHue: number | null;
}): Promise<void> {
  await getAndroidModule()?.start(target.agentId, target.serverId, target.agentName, target.avatarHue);
}

export async function stopLiveVoiceBackgroundService(): Promise<void> {
  await getAndroidModule()?.stop();
}

export async function saveWakeWordTarget(target: {
  agentId: string;
  serverId: string;
  agentName: string;
  avatarHue: number | null;
}): Promise<void> {
  await getAndroidModule()?.setWakeWordTarget(target.serverId, target.agentId, target.agentName, target.avatarHue);
}

export async function getWakeWordStatus(): Promise<WakeWordStatus> {
  return (
    (await getAndroidModule()?.getWakeWordStatus()) ?? {
      armed: false,
      listening: false,
      starting: false,
      serverId: null,
      agentId: null,
      agentName: null,
      avatarHue: null,
    }
  );
}

export async function startWakeWordListening(): Promise<void> {
  await getAndroidModule()?.startWakeWord();
}

export async function stopWakeWordListening(): Promise<void> {
  await getAndroidModule()?.stopWakeWord();
}

export async function pauseWakeWordCapture(): Promise<void> {
  await getAndroidModule()?.pauseWakeWord();
}

export async function resumeWakeWordCapture(): Promise<void> {
  await getAndroidModule()?.resumeWakeWord();
}

export async function consumeWakeWordDetection(): Promise<WakeWordDetection | null> {
  return (await getAndroidModule()?.consumeWakeWordDetection()) ?? null;
}

export async function consumePendingVoiceEndAction(): Promise<boolean> {
  return (await getAndroidModule()?.consumePendingVoiceEndAction()) ?? false;
}
