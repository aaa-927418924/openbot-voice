export interface MicrophonePermissionAdapter {
  hasPermission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
}

/** Requests microphone access only when Live Voice is started and Android has not granted it yet. */
export async function ensureMicrophonePermission(adapter: MicrophonePermissionAdapter): Promise<boolean> {
  if (await adapter.hasPermission()) return true;
  return adapter.requestPermission();
}
