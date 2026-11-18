/**
 * Minimal counting semaphore: at most `limit` tasks run at once, the rest wait FIFO.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
  }

  /** Number of tasks currently running. */
  get running(): number {
    return this.active;
  }

  /** Number of tasks waiting for a slot. */
  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot over directly
      else this.active--;
    }
  }
}
