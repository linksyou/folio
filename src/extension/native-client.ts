import { AppError } from "../shared/errors.js";
import { HOST_NAME, type HostCommand, type NativeMessage, type Translation } from "../shared/protocol.js";

// Keep the host's HTTP pool alive across normal reading pauses. Disconnecting
// after five seconds discarded reusable TLS connections between scrolls.
const HOST_IDLE_MS = 60_000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  onProgress?: (translations: Translation[]) => void;
}

/** The worker owns the port, so closing the popup never cancels page work. */
export class NativeClient {
  private port?: chrome.runtime.Port;
  private pending = new Map<string, Pending>();
  private idleTimer?: ReturnType<typeof setTimeout>;

  request<T>(command: HostCommand, onProgress?: (translations: Translation[]) => void): Promise<T> {
    clearTimeout(this.idleTimer);
    if (!this.port) this.connect();
    const port = this.port!;
    const id = crypto.randomUUID();
    const timeout = command.type === "auth.login" ? 10 * 60_000 :
      command.type === "translate" || command.type === "connection.test" ? 240_000 : 90_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (command.type === "translate") this.cancelTimedOutTranslation(command, port);
        reject(new AppError("HOST_UNAVAILABLE", "本地程序响应超时，请重试。"));
        this.scheduleIdle();
      }, timeout);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, onProgress });
      try { port.postMessage({ id, command }); }
      catch {
        this.failAll();
      }
    });
  }

  private cancelTimedOutTranslation(command: Extract<HostCommand, { type: "translate" }>, port: chrome.runtime.Port): void {
    // Cancel only on the connection that owns the request. A replacement host
    // has no matching work, and cancellation must never reconnect by itself.
    if (this.port !== port) return;
    const cancel: HostCommand = command.batchId
      ? { type: "translate.cancelBatch", jobId: command.jobId, batchId: command.batchId }
      : { type: "translate.cancel", jobId: command.jobId };
    try {
      // This best-effort control message intentionally has no pending entry or
      // timer. Its reply is ignored; a missing reply cannot keep the host alive
      // or recursively time out while other requests continue independently.
      port.postMessage({ id: crypto.randomUUID(), command: cancel });
    } catch {
      // A timeout is already being reported. onDisconnect handles a broken
      // connection; failing to send cancellation must not reject other work.
    }
  }

  private connect(): void {
    const port = chrome.runtime.connectNative(HOST_NAME);
    this.port = port;
    port.onMessage.addListener((message: NativeMessage) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if ("event" in message) {
        if (message.event === "translation.progress") pending.onProgress?.(message.translations);
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new AppError(message.error.code, message.error.message));
      this.scheduleIdle();
    });
    port.onDisconnect.addListener(() => {
      // Reading lastError suppresses Chromium's unchecked runtime error without exposing paths.
      void chrome.runtime.lastError;
      if (this.port === port) this.failAll();
    });
  }

  private failAll(): void {
    this.port = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError("HOST_UNAVAILABLE", "本地辅助程序未连接，请完成安装后重试。"));
    }
    this.pending.clear();
  }

  private scheduleIdle(): void {
    if (this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size > 0) return;
      const port = this.port;
      this.port = undefined;
      port?.disconnect();
    }, HOST_IDLE_MS);
  }
}
