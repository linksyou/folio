import { createHash } from "node:crypto";
import { AppError } from "../shared/errors.js";
import { PROTOCOL_VERSION, type AuthStatus, type HostCommand, type HostStatus, type Translation } from "../shared/protocol.js";
import { ChatGPTAuth } from "./auth/index.js";
import { ModelProviders } from "./providers.js";
import { RequestQueue } from "./queue.js";
import { publicSettings, SettingsStore } from "./settings.js";
import { TimingLog } from "../shared/diagnostics.js";

/** Owns one browser connection. Network work is bounded across all its tabs. */
export class HostService {
  private readonly queue = new RequestQueue(2);
  private readonly jobs = new Map<string, { controller: AbortController; users: number }>();
  private readonly cancelled = new Set<string>();
  private readonly batches = new Map<string, { controller: AbortController; users: number }>();
  private readonly cancelledBatches = new Set<string>();
  private readonly operations = new Set<AbortController>();
  private generation = 0;
  private readonly timings = new TimingLog("host");
  private readonly activeSignals = new Map<string, AbortSignal>();
  private settingsWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: SettingsStore,
    private readonly auth: ChatGPTAuth,
    private readonly providers: ModelProviders,
    private readonly options: { translationTimeoutMs?: number } = {},
  ) {}

  private makeStatus(settings: Awaited<ReturnType<SettingsStore["read"]>>, auth: AuthStatus): HostStatus {
    // Token refresh does not invalidate translations; changing account or configuration does.
    const revision = createHash("sha256")
      .update(JSON.stringify([settings.revision, auth.profile?.id, auth.state, auth.planEnabled]))
      .digest("hex");
    return {
      protocolVersion: PROTOCOL_VERSION,
      settings: publicSettings(settings), settingsRevision: revision, auth,
    };
  }

  async status(signal?: AbortSignal): Promise<HostStatus> {
    // A status may be used immediately as a translation identity. Never expose
    // the file's new revision before its old jobs have been invalidated.
    for (;;) {
      const writes = this.settingsWrites;
      await this.waitForWrite(writes, signal);
      const [settings, auth] = await Promise.all([this.settings.read(), this.auth.status()]);
      if (writes === this.settingsWrites) return this.makeStatus(settings, auth);
    }
  }

  private waitForWrite(writes: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return writes;
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new AppError("CANCELLED", "翻译已停止。"));
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener("abort", cancel, { once: true });
      void writes.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }

  private async waitForSettingsWrites(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const writes = this.settingsWrites;
      await this.waitForWrite(writes, signal);
      if (writes === this.settingsWrites) return;
    }
  }

  isTranslationActive(jobId: string, batchId: string): boolean {
    const signal = this.activeSignals.get(this.batchKey(jobId, batchId));
    return !!signal && !signal.aborted;
  }

  private async runOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.operations.add(controller);
    try { return await operation(controller.signal); }
    finally { this.operations.delete(controller); }
  }

  async handle(command: HostCommand, onProgress?: (translations: Translation[]) => void): Promise<unknown> {
    switch (command.type) {
      case "status": return this.status();
      case "diagnostics.get": return this.timings.read();
      case "settings.save": {
        // Serialize saves as a transaction relative to request validation and
        // final results. Failed or presentation-only saves leave streams alive.
        const save = this.settingsWrites.then(async () => {
          const before = await this.settings.read();
          const saved = await this.settings.save(command.settings);
          if (saved.revision !== before.revision) this.cancelAll();
          return this.makeStatus(saved, await this.auth.status());
        });
        this.settingsWrites = save.then(() => undefined, () => undefined);
        return save;
      }
      case "auth.login":
        this.cancelAll();
        await this.auth.signIn({ newAccount: command.newAccount });
        return this.status();
      case "auth.cancel":
        this.auth.cancelSignIn();
        return {};
      case "auth.logout":
        this.cancelAll();
        return this.auth.signOut();
      case "auth.select":
        this.cancelAll();
        await this.auth.selectProfile(command.profileId);
        return this.status();
      case "models.list": return this.runOperation((signal) => this.providers.listModels(signal));
      case "connection.prepare": return this.runOperation(async (signal) => {
        // Best effort: a gateway may reject preflight requests while accepting
        // authenticated model calls. Preparation must not block that fallback.
        const started = performance.now();
        this.timings.mark("prepare.start");
        let ready = false;
        try {
          const settings = await this.settings.read();
          signal.throwIfAborted();
          ready = await this.providers.prepare(settings, signal);
          return { ready };
        } catch {
          return { ready: false };
        } finally {
          this.timings.mark("prepare.end", {}, { durationMs: performance.now() - started, ready });
        }
      });
      case "connection.test": return this.runOperation(async (controllerSignal) => {
        const settings = await this.settings.read();
        const signal = AbortSignal.any([controllerSignal, AbortSignal.timeout(180_000)]);
        const translated = await this.queue.run(signal, () =>
          this.providers.translate(settings, [{ id: "test", text: "Welcome to your bilingual reading space." }], signal));
        return { text: translated[0].text };
      });
      case "translate.cancel":
        this.cancel(command.jobId);
        return {};
      case "translate.cancelBatch":
        this.cancelBatch(command.jobId, command.batchId);
        return {};
      case "translate": {
        if (this.cancelled.has(command.jobId)) throw new AppError("CANCELLED", "翻译已停止。");
        const batchKey = command.batchId ? this.batchKey(command.jobId, command.batchId) : undefined;
        if (batchKey && this.cancelledBatches.has(batchKey)) {
          throw new AppError("CANCELLED", "这批翻译已取消。");
        }
        let job = this.jobs.get(command.jobId);
        if (!job) {
          job = { controller: new AbortController(), users: 0 };
          this.jobs.set(command.jobId, job);
        }
        job.users++;
        let batch = batchKey ? this.batches.get(batchKey) : undefined;
        if (batchKey && !batch) {
          batch = { controller: new AbortController(), users: 0 };
          this.batches.set(batchKey, batch);
        }
        if (batch) batch.users++;
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(new AppError("TIMEOUT", "这批翻译等待超时，请重试。")), this.options.translationTimeoutMs ?? 180_000);
        const signal = AbortSignal.any([job.controller.signal, ...(batch ? [batch.controller.signal] : []), deadline.signal]);
        if (batchKey) this.activeSignals.set(batchKey, signal);
        const generation = this.generation;
        const identity = { jobId: command.jobId, batchId: command.batchId };
        const started = performance.now();
        let completed = false;
        this.timings.mark("queue.enter", identity, { blocks: command.blocks.length, characters: command.blocks.reduce((n, b) => n + b.text.length, 0) });
        try {
          return await this.queue.run(signal, async () => {
            this.timings.mark("queue.leave", identity, { waitMs: performance.now() - started });
            await this.waitForSettingsWrites(signal);
            const settings = await this.settings.read();
            const auth = await this.auth.status();
            const status = this.makeStatus(settings, auth);
            if (status.settingsRevision !== command.settingsRevision ||
                (await this.status(signal)).settingsRevision !== command.settingsRevision) {
              throw new AppError("CONFIG_REQUIRED", "账号或配置已变化，请重新开始翻译。");
            }
            signal.throwIfAborted();
            this.timings.mark("provider.start", identity);
            let firstProgress = true;
            const progress = onProgress ? (translations: Translation[]) => {
              if (!signal.aborted && generation === this.generation) {
                if (firstProgress) { this.timings.mark("provider.firstPreview", identity); firstProgress = false; }
                onProgress(translations);
              }
            } : undefined;
            const translated = await this.providers.translate(settings, command.blocks, signal, progress,
              (stage, values) => this.timings.mark(stage, identity, values));
            await this.waitForSettingsWrites(signal);
            const latest = await this.status(signal);
            if (signal.aborted || generation !== this.generation) {
              throw new AppError("CANCELLED", "翻译已停止。");
            }
            if (latest.settingsRevision !== command.settingsRevision) {
              throw new AppError("CONFIG_REQUIRED", "账号或配置已变化，请重新开始翻译。");
            }
            completed = true;
            return translated;
          });
        } catch (error) {
          if (signal.reason instanceof AppError && signal.reason.code === "TIMEOUT") throw signal.reason;
          throw error;
        } finally {
          if (batchKey && this.activeSignals.get(batchKey) === signal) this.activeSignals.delete(batchKey);
          clearTimeout(timer);
          this.timings.mark("batch.end", identity, { durationMs: performance.now() - started, completed, cancelled: signal.aborted, timedOut: deadline.signal.aborted });
          if (batch && batchKey) {
            batch.users--;
            if (batch.users === 0) this.batches.delete(batchKey);
          }
          job.users--;
          if (job.users === 0) this.jobs.delete(command.jobId);
        }
      }
    }
  }

  private cancel(id: string): void {
    this.jobs.get(id)?.controller.abort();
    this.cancelled.add(id);
    // A connection lives only while it is used; cap tombstones for unusually long sessions.
    if (this.cancelled.size > 2_000) this.cancelled.delete(this.cancelled.values().next().value!);
  }

  private batchKey(jobId: string, batchId: string): string {
    return `${jobId}\u0000${batchId}`;
  }

  private cancelBatch(jobId: string, batchId: string): void {
    const key = this.batchKey(jobId, batchId);
    this.batches.get(key)?.controller.abort();
    this.cancelledBatches.add(key);
    // Batch ids are unique within a page job; bound pre-cancel tombstones for long browser sessions.
    if (this.cancelledBatches.size > 4_000) {
      this.cancelledBatches.delete(this.cancelledBatches.values().next().value!);
    }
  }

  cancelAll(): void {
    this.generation++;
    for (const id of this.jobs.keys()) this.cancel(id);
    for (const controller of this.operations) controller.abort();
  }

  close(): void {
    this.cancelAll();
    this.auth.cancelSignIn();
  }
}
