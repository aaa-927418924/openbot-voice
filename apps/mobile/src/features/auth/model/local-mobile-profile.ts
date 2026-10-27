import { isAvatarMimeType, isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { AVATAR_IMAGE_LIMITS } from "@openbot/contracts/input-limits";
import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { validateProfileName } from "@openbot/contracts/validation";
import * as Crypto from "expo-crypto";
import { File, Paths } from "expo-file-system";
import type { MobileProfileChange, MobileSession } from "../api/mobile-auth";

const LOCAL_PROFILE_FILE = "openbot-local-profile-v1.json";
const LOCAL_PROFILE_API_URL = "http://127.0.0.1/";

interface LocalAvatar {
  mimeType: string;
  data: string;
}

interface LocalProfileRecord {
  version: 1;
  id: string;
  name: string;
  avatar: LocalAvatar | null;
}

let profileWriteTail = Promise.resolve();

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeProfile(value: unknown): LocalProfileRecord {
  if (!isDynamicRecord(value) || value.version !== 1 || !isString(value.id) || !isString(value.name)) {
    throw new Error("The local OpenBot profile is invalid.");
  }
  const name = validateProfileName(value.name);
  if (name.error) throw new Error("The local OpenBot profile name is invalid.");
  let avatar: LocalAvatar | null = null;
  if (value.avatar !== null) {
    if (
      !isDynamicRecord(value.avatar) ||
      !isString(value.avatar.mimeType) ||
      !isAvatarMimeType(value.avatar.mimeType) ||
      !isString(value.avatar.data)
    ) {
      throw new Error("The local OpenBot profile image is invalid.");
    }
    const bytes = base64ToBytes(value.avatar.data);
    if (!isValidAvatarImage(value.avatar.mimeType, bytes))
      throw new Error("The local OpenBot profile image is invalid.");
    avatar = { mimeType: value.avatar.mimeType, data: bytesToBase64(bytes) };
  }
  return { version: 1, id: value.id, name: name.name, avatar };
}

function localUser(profile: LocalProfileRecord): CentralAuthUser {
  return {
    id: profile.id,
    email: "",
    name: profile.name,
    avatarUrl: profile.avatar ? `data:${profile.avatar.mimeType};base64,${profile.avatar.data}` : null,
  };
}

function asLocalSession(user: CentralAuthUser): MobileSession {
  return { apiUrl: LOCAL_PROFILE_API_URL, sessionToken: "", user, localOnly: true };
}

async function withProfileWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = profileWriteTail.then(operation, operation);
  profileWriteTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readRecord(): Promise<LocalProfileRecord> {
  const file = new File(Paths.document, LOCAL_PROFILE_FILE);
  if (!file.exists) {
    const initial = { version: 1 as const, id: Crypto.randomUUID(), name: "OpenBot", avatar: null };
    file.write(JSON.stringify(initial));
    return initial;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("The local OpenBot profile could not be read.");
  }
  return decodeProfile(parsed);
}

/** Creates an in-memory profile if persistent local storage cannot be read; it never overwrites the file. */
export function createEphemeralLocalMobileProfile(): MobileSession {
  return asLocalSession({ id: Crypto.randomUUID(), email: "", name: "OpenBot", avatarUrl: null });
}

/** Creates or reads the profile that replaces email sign-in on a local-only mobile build. */
export async function readLocalMobileProfile(): Promise<MobileSession> {
  return withProfileWrite(async () => asLocalSession(localUser(await readRecord())));
}

/** Updates the device-only name or avatar without contacting an account API. */
export async function updateLocalMobileProfile(
  session: MobileSession,
  change: MobileProfileChange,
): Promise<MobileSession> {
  if (!session.localOnly) throw new Error("This profile is not local.");
  return withProfileWrite(async () => {
    const current = await readRecord();
    if ("name" in change) {
      const name = validateProfileName(change.name);
      if (name.error) throw new Error("The local OpenBot profile name is invalid.");
      current.name = name.name;
    } else if (change.avatar === null) {
      current.avatar = null;
    } else {
      if (change.avatar.bytes.byteLength > AVATAR_IMAGE_LIMITS.storedBytes)
        throw new Error("The selected profile image is too large.");
      if (!isValidAvatarImage(change.avatar.mimeType, change.avatar.bytes))
        throw new Error("The selected profile image is invalid.");
      current.avatar = { mimeType: change.avatar.mimeType, data: bytesToBase64(change.avatar.bytes) };
    }
    new File(Paths.document, LOCAL_PROFILE_FILE).write(JSON.stringify(current));
    return asLocalSession(localUser(current));
  });
}
