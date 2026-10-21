import { AppError } from "../shared/errors.js";

/** A small shared limit prevents multiple tabs from flooding the provider. */
export class RequestQueue {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly concurrency = 2) {}

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        this.waiting = this.waiting.filter((entry) => entry !== start);
        reject(new AppError("CANCELLED", "翻译已停止。"));
      };
      const start = () => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) { cancel(); return; }
        this.active++;
        resolve();
      };
      if (signal.aborted) { cancel(); return; }
      if (this.active < this.concurrency) start();
      else {
        this.waiting.push(start);
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
