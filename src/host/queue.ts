import { AppError } from "../shared/errors.js";
import type { TranslationPriority } from "../shared/protocol.js";

/** A small shared limit prevents multiple tabs from flooding the provider. */
export class RequestQueue {
  private active = 0;
  private waiting: Array<{ start: () => void; priority: number }> = [];
  private overtakes = 0;

  constructor(private readonly concurrency = 2) {}

  async run<T>(signal: AbortSignal, operation: () => Promise<T>, priority: TranslationPriority = "prefetch"): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        this.waiting = this.waiting.filter((entry) => entry.start !== start);
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
        this.waiting.push({ start, priority: priority === "visible" ? 0 : priority === "background" ? 2 : 1 });
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      this.active--;
      if (this.waiting.length) {
        // At most eight overtakes before serving the oldest waiting request.
        // Active model work is never restarted just to change queue order.
        const best = this.waiting.reduce((index, entry, next) => entry.priority < this.waiting[index].priority ? next : index, 0);
        const index = this.overtakes >= 8 ? 0 : best;
        this.overtakes = index === 0 ? 0 : this.overtakes + 1;
        this.waiting.splice(index, 1)[0].start();
      }
    }
  }
}
