import { randomUUID } from "node:crypto";
import { isAvatarMimeType, isValidAvatarImage } from "@openbot/contracts/avatar-images";
import type { AvatarImageInput, CentralAuthState, CentralAuthUser } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { validateProfileName } from "@openbot/contracts/validation";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

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

function decodeProfile(value: unknown): LocalProfileRecord {
  if (!isDynamicRecord(value) || value.version !== 1 || !isString(value.id) || !isString(value.name)) {
    throw new Error("The local profile file is invalid.");
  }
  const validation = validateProfileName(value.name);
  if (validation.error) throw new Error("The local profile name is invalid.");
  let avatar: LocalAvatar | null = null;
  if (value.avatar !== null) {
    if (
      !isDynamicRecord(value.avatar) ||
      !isString(value.avatar.mimeType) ||
      !isAvatarMimeType(value.avatar.mimeType) ||
      !isString(value.avatar.data)
    ) {
      throw new Error("The local profile avatar is invalid.");
    }
    const bytes = Buffer.from(value.avatar.data, "base64");
    if (!isValidAvatarImage(value.avatar.mimeType, bytes)) throw new Error("The local profile avatar is invalid.");
    avatar = { mimeType: value.avatar.mimeType, data: bytes.toString("base64") };
  }
  return { version: 1, id: value.id, name: validation.name, avatar };
}

/** A profile stored on this device. It has no email address or remote account session. */
export class LocalProfileStore {
  readonly #path: string;
  readonly #writes = Semaphore.makeUnsafe(1);
  #record: LocalProfileRecord = { version: 1, id: randomUUID(), name: "OpenBot", avatar: null };
  #loadFailure: PreferenceFileFailure | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  load(): Effect.Effect<void, PreferenceFileFailure> {
    return Effect.gen({ self: this }, function* () {
      const loaded = yield* Effect.result(readPreferenceFile(this.#path, decodeProfile));
      if (Result.isSuccess(loaded)) {
        this.#record = loaded.success;
        this.#loadFailure = null;
        return;
      }
      if (isMissingFileError(loaded.failure.cause)) {
        yield* this.#persist(this.#record);
        return;
      }
      // A bad or future profile is left untouched. The user can still open the app, but a later
      // profile edit will report the persistence failure instead of silently replacing the file.
      this.#loadFailure = loaded.failure;
    });
  }

  getUser(): CentralAuthUser {
    return {
      id: this.#record.id,
      email: "",
      name: this.#record.name,
      avatarUrl: this.#record.avatar ? `data:${this.#record.avatar.mimeType};base64,${this.#record.avatar.data}` : null,
    };
  }

  getState(): CentralAuthState {
    return { status: "signed_in", user: this.getUser() };
  }

  readonly updateName = Effect.fn("LocalProfileStore.updateName")(function* (
    this: LocalProfileStore,
    name: string,
  ): Effect.fn.Return<CentralAuthState, PreferenceFileFailure> {
    const validation = validateProfileName(name);
    if (validation.error) throw new Error("The local profile name is invalid.");
    const next = { ...this.#record, name: validation.name };
    yield* this.#persist(next);
    this.#record = next;
    return this.getState();
  });

  readonly updateAvatar = Effect.fn("LocalProfileStore.updateAvatar")(function* (
    this: LocalProfileStore,
    image: AvatarImageInput | null,
  ): Effect.fn.Return<CentralAuthState, PreferenceFileFailure> {
    const next = {
      ...this.#record,
      avatar: image ? { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString("base64") } : null,
    };
    yield* this.#persist(next);
    this.#record = next;
    return this.getState();
  });

  #persist(record: LocalProfileRecord): Effect.Effect<void, PreferenceFileFailure> {
    if (this.#loadFailure) return Effect.fail(this.#loadFailure);
    return this.#writes.withPermit(
      Effect.uninterruptible(writePreferenceFile(this.#path, record, { createDirectory: true })),
    );
  }
}
