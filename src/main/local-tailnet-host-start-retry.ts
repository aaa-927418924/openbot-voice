import type { HostStatus } from "@openbot/contracts/ipc";

const RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;

export interface LocalTailnetHostStartRetryOptions {
  startHost: () => Promise<HostStatus>;
  onError: (error: unknown) => void;
}

/** Keeps the accountless local host available when Tailscale starts after OpenBot. */
export class LocalTailnetHostStartRetry {
  readonly #options: LocalTailnetHostStartRetryOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: Promise<HostStatus | null> | null = null;
  #retryIndex = 0;
  #stopped = true;

  constructor(options: LocalTailnetHostStartRetryOptions) {
    this.#options = options;
  }

  start(): Promise<HostStatus | null> {
    this.#stopped = false;
    // Enabling the local host can happen while the background retry loop is already alive.
    // In that case return an actual start attempt instead of a resolved null that makes the
    // settings action fail before the scheduled retry gets a chance to run.
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    return this.#attempt();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#pending;
  }

  async #attempt(): Promise<HostStatus | null> {
    if (this.#stopped) return null;
    if (this.#pending) return this.#pending;
    const pending = (async () => {
      try {
        const status = await this.#options.startHost();
        if (status.phase === "online" && status.apiOnline) {
          this.#retryIndex = 0;
          return status;
        }
        this.#options.onError(new Error(status.message || "The local Tailscale host is not online."));
        this.#schedule();
        return status;
      } catch (error) {
        this.#options.onError(error);
        this.#schedule();
        return null;
      }
    })();
    this.#pending = pending;
    try {
      return await pending;
    } finally {
      if (this.#pending === pending) this.#pending = null;
    }
  }

  #schedule(): void {
    if (this.#stopped || this.#timer) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.#retryIndex, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
    this.#retryIndex += 1;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#attempt();
    }, delay);
    this.#timer.unref?.();
  }
}
