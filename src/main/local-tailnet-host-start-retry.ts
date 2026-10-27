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
  #pending: Promise<void> | null = null;
  #retryIndex = 0;
  #stopped = true;

  constructor(options: LocalTailnetHostStartRetryOptions) {
    this.#options = options;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#attempt();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#pending;
  }

  async #attempt(): Promise<void> {
    if (this.#stopped || this.#pending) return;
    const pending = (async () => {
      try {
        const status = await this.#options.startHost();
        if (status.phase === "online" && status.apiOnline) {
          this.#retryIndex = 0;
          return;
        }
        this.#options.onError(new Error(status.message || "The local Tailscale host is not online."));
      } catch (error) {
        this.#options.onError(error);
      }
      this.#schedule();
    })();
    this.#pending = pending;
    try {
      await pending;
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
