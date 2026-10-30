import { readFile } from "node:fs/promises";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";

/** Persists whether this desktop instance should publish its local Team host. */
export class LocalServerPreferenceStore {
  readonly #path: string;
  #enabled = true;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async initialize(defaultEnabled = true): Promise<void> {
    this.#enabled = defaultEnabled;
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"));
      if (!isDynamicRecord(parsed) || parsed.version !== 1 || typeof parsed.enabled !== "boolean") {
        this.#enabled = false;
        return;
      }
      this.#enabled = parsed.enabled;
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      if (error instanceof SyntaxError) this.#enabled = false;
      if (error instanceof SyntaxError) return;
      throw new Error("The local server setting could not be read.");
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  async setEnabled(enabled: boolean): Promise<boolean> {
    const operation = this.#writeTail.then(async () => {
      await Effect.runPromise(writeJsonFileAtomically(this.#path, { version: 1, enabled }, { createDirectory: true }));
      this.#enabled = enabled;
      return enabled;
    });
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
