import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

interface LiveVoiceBackgroundServiceModule {
  start(): Promise<void>;
  stop(): Promise<void>;
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

export async function startLiveVoiceBackgroundService(): Promise<void> {
  await getAndroidModule()?.start();
}

export async function stopLiveVoiceBackgroundService(): Promise<void> {
  await getAndroidModule()?.stop();
}
