import type { RemoteFileUpload } from "@openbot/team-client/remote-peer";
import * as Crypto from "expo-crypto";
import { requireOptionalNativeModule } from "expo-modules-core";

interface RangeRequest {
  requestId: string;
  streamId: string;
  offset: number;
  length: number;
}

interface NativeVideoStreamModule {
  addListener(eventName: "rangeRequested", listener: (event: RangeRequest) => void): { remove(): void };
  start(streamId: string, attachmentId: string, size: number, mimeType: string): Promise<string>;
  respond(requestId: string, base64: string): Promise<void>;
  fail(requestId: string): Promise<void>;
  stop(streamId: string): Promise<void>;
}

let nativeModule: NativeVideoStreamModule | null | undefined;
let subscription: { remove(): void } | null = null;
const rangeLoaders = new Map<string, (offset: number, length: number) => Promise<RemoteFileUpload>>();

function getNativeModule(): NativeVideoStreamModule | null {
  if (nativeModule === undefined) {
    nativeModule = requireOptionalNativeModule<NativeVideoStreamModule>("OpenBotAttachmentVideoStream");
  }
  return nativeModule;
}

function observeRanges(module: NativeVideoStreamModule) {
  if (subscription) return;
  subscription = module.addListener("rangeRequested", (event) => {
    const loadRange = rangeLoaders.get(event.streamId);
    if (!loadRange || !Number.isSafeInteger(event.offset) || !Number.isSafeInteger(event.length) || event.length < 1) {
      void module.fail(event.requestId);
      return;
    }
    void loadRange(event.offset, event.length)
      .then((file) => module.respond(event.requestId, file.base64))
      .catch(() => module.fail(event.requestId));
  });
}

/** Starts a loopback source; Media3 requests ranges as it buffers or seeks in the video. */
export async function openAttachmentVideoStream(
  attachmentId: string,
  size: number,
  mimeType: string,
  loadRange: (offset: number, length: number) => Promise<RemoteFileUpload>,
): Promise<{ uri: string; close: () => Promise<void> }> {
  const module = getNativeModule();
  if (!module) throw new Error("Progressive video playback is unavailable in this app build.");
  const streamId = Crypto.randomUUID();
  rangeLoaders.set(streamId, loadRange);
  observeRanges(module);
  try {
    const uri = await module.start(streamId, attachmentId, size, mimeType);
    let closed = false;
    return {
      uri,
      close: async () => {
        if (closed) return;
        closed = true;
        rangeLoaders.delete(streamId);
        if (rangeLoaders.size === 0) {
          subscription?.remove();
          subscription = null;
        }
        await module.stop(streamId);
      },
    };
  } catch (error) {
    rangeLoaders.delete(streamId);
    if (rangeLoaders.size === 0) {
      subscription?.remove();
      subscription = null;
    }
    await module.stop(streamId).catch(() => undefined);
    throw error;
  }
}
