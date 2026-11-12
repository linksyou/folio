import { AppError } from "../shared/errors.js";
import { MAX_BATCH_CHARACTERS, TRANSLATION_PROMPT_VERSION, type TextBlock, type Translation, type TranslationPriority } from "../shared/protocol.js";
import { TranslationCache } from "./translation-cache.js";
import { preservesProtectedText } from "../shared/protected-text.js";
import { cacheDocumentUrl } from "./cache-document-url.js";

export interface TranslationReuseRequest {
  jobId: string;
  batchId: string;
  settingsRevision: string;
  origin: string;
  url: string;
  blocks: TextBlock[];
  force?: boolean;
  enabled?: boolean;
  priority?: TranslationPriority;
  anchorFragment?: boolean;
}

export interface TranslationReuseProvider {
  translate(request: { jobId: string; batchId: string; settingsRevision: string; blocks: TextBlock[]; priority?: TranslationPriority }, onProgress: (translations: Translation[]) => void): Promise<Translation[]>;
  cancel(jobId: string, batchId: string): void | Promise<void>;
}

export interface TranslationReuseLink {
  jobId: string;
  batchId: string;
  providerJobId: string;
  providerBatchId: string;
}

interface Consumer {
  request: TranslationReuseRequest;
  resolve: (translations: Translation[]) => void;
  reject: (error: unknown) => void;
  onProgress?: (translations: Translation[]) => void;
  links: Map<WorkItem, string[]>;
  results: Map<string, string>;
  linkedGroups: Set<string>;
  ended: boolean;
  persist: boolean;
  epoch: string;
}

interface WorkItem {
  key: string;
  shareKey: string;
  origin: string;
  text: string;
  id: string;
  version: number;
  subscribers: Map<Consumer, string[]>;
  group?: ProviderGroup;
  latest?: string;
}

interface ProviderGroup {
  jobId: string;
  batchId: string;
  items: WorkItem[];
  active: boolean;
}

/** Owns shared work independently of any page's cancellation or DOM identity. */
export class TranslationReuse {
  private consumers = new Map<string, Consumer>();
  private inFlight = new Map<string, WorkItem>();
  private versions = new Map<string, number>();
  private originEpochs = new Map<string, number>();
  private globalEpoch = 0;
  private sequence = 0;
  private enabled = true;

  constructor(
    private readonly cache: TranslationCache,
    private readonly provider: TranslationReuseProvider,
    private readonly options: { onLink?: (link: TranslationReuseLink) => void } = {},
  ) {}

  translate(request: TranslationReuseRequest, onProgress?: (translations: Translation[]) => void): Promise<Translation[]> {
    if (!request.blocks.length || new Set(request.blocks.map((block) => block.id)).size !== request.blocks.length ||
        request.blocks.some((block) => !block.id || typeof block.text !== "string" || !block.text.trim())) {
      return Promise.reject(new AppError("INVALID_REQUEST", "翻译内容无效。"));
    }
    const identity = this.identity(request.jobId, request.batchId);
    if (this.consumers.has(identity)) return Promise.reject(new AppError("INVALID_REQUEST", "翻译批次已在执行。"));
    const result = new Promise<Translation[]>((resolve, reject) => {
      const consumer: Consumer = {
        request, resolve, reject, onProgress, links: new Map(), results: new Map(), linkedGroups: new Set(), ended: false,
        persist: this.enabled && request.enabled !== false,
        epoch: this.epoch(request.origin),
      };
      this.consumers.set(identity, consumer);
      void this.prepare(consumer).catch((error) => this.failConsumer(consumer, error));
    });
    return result;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.globalEpoch++;
  }

  cancelJob(jobId: string): void {
    for (const consumer of [...this.consumers.values()]) {
      if (consumer.request.jobId === jobId) this.failConsumer(consumer, this.cancelled());
    }
  }

  cancelBatch(jobId: string, batchId: string): void {
    const consumer = this.consumers.get(this.identity(jobId, batchId));
    if (consumer) this.failConsumer(consumer, this.cancelled());
  }

  clear(origin?: string): Promise<void> {
    // Advance synchronously: a result arriving while deletion is pending cannot refill the cache.
    if (origin === undefined) { this.globalEpoch++; this.originEpochs.clear(); }
    else this.originEpochs.set(origin, (this.originEpochs.get(origin) ?? 0) + 1);
    return this.cache.clear(origin).finally(() => { if (origin !== undefined) this.pruneOriginEpoch(origin); });
  }

  stats() { return this.cache.stats(); }

  private identity(jobId: string, batchId: string) { return JSON.stringify([jobId, batchId]); }
  private epoch(origin: string) { return `${this.globalEpoch}:${this.originEpochs.get(origin) ?? 0}`; }
  private cancelled() { return new AppError("CANCELLED", "操作已停止。"); }

  private async prepare(consumer: Consumer): Promise<void> {
    const request = consumer.request;
    const keys = await Promise.all(request.blocks.map(async (block) => {
      const input = JSON.stringify([request.origin, cacheDocumentUrl(request.url, request.anchorFragment), request.settingsRevision, TRANSLATION_PROMPT_VERSION, block.text]);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
      return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }));
    if (consumer.ended) return;
    const created: WorkItem[] = [];
    for (const [index, block] of request.blocks.entries()) {
      if (consumer.ended) return;
      const key = keys[index];
      const domain = request.force ? ["force", request.jobId] : consumer.persist ? ["shared"] : ["ephemeral", request.jobId];
      const shareKey = JSON.stringify([consumer.epoch, domain, key]);
      let item = this.inFlight.get(shareKey);
      if (!item) {
        const version = ++this.sequence;
        item = { key, shareKey, origin: request.origin, text: block.text, id: crypto.randomUUID(), version, subscribers: new Map() };
        this.inFlight.set(shareKey, item);
        created.push(item);
      }
      const ids = item.subscribers.get(consumer) ?? [];
      ids.push(block.id);
      item.subscribers.set(consumer, ids);
      consumer.links.set(item, ids);
      if (item.group) this.link(consumer, item.group);
      if (item.latest !== undefined) this.progress(consumer, [{ id: block.id, text: item.latest }]);
    }

    const misses: WorkItem[] = [];
    const cachedEntries = consumer.persist && !request.force
      ? await this.cache.getMany(created.filter(item => item.text.length <= MAX_BATCH_CHARACTERS).map(item => item.key))
      : new Map<string, string>();
    await Promise.all(created.map(async (item) => {
      const cached = cachedEntries.get(item.key);
      if (!item.subscribers.size) return;
      if (cached !== undefined && consumer.epoch === this.epoch(request.origin) && this.enabled) {
        // A mixed batch can show its known text while the missing peers stream.
        // Page completion still waits for the full consumer result.
        for (const [subscriber, ids] of item.subscribers) {
          this.progress(subscriber, ids.map((id) => ({ id, text: cached })));
        }
        this.completeItem(item, cached);
      } else misses.push(item);
    }));
    // The creating consumer may stop while another consumer still owns some of its items.
    const active = misses.filter((item) => item.subscribers.size > 0);
    if (!active.length) return;
    const group: ProviderGroup = { jobId: crypto.randomUUID(), batchId: crypto.randomUUID(), items: active, active: true };
    const linked = new Set<Consumer>();
    for (const item of active) {
      // A cache hit must not suppress an already running forced replacement.
      this.versions.set(item.key, Math.max(this.versions.get(item.key) ?? 0, item.version));
      item.group = group;
      for (const subscriber of item.subscribers.keys()) linked.add(subscriber);
    }
    for (const subscriber of linked) this.link(subscriber, group);
    // Promise.resolve also catches a provider throwing before it returns a promise.
    void Promise.resolve().then(() => {
      if (!group.active) throw this.cancelled();
      return this.provider.translate({
        jobId: group.jobId, batchId: group.batchId, settingsRevision: request.settingsRevision,
        priority: request.priority,
        blocks: active.map((item) => ({ id: item.id, text: item.text })),
      }, (translations) => this.receiveProgress(group, translations));
    }).then(
      (translations) => this.completeGroup(group, translations),
      (error) => this.failGroup(group, error),
    ).catch((error) => this.failGroup(group, error));
  }

  private receiveProgress(group: ProviderGroup, translations: Translation[]): void {
    if (!group.active || !Array.isArray(translations)) return;
    const recipients = new Map<Consumer, Translation[]>();
    for (const translation of translations) {
      if (!translation || typeof translation.text !== "string") continue;
      const item = group.items.find((candidate) => candidate.id === translation.id);
      if (!item) continue;
      item.latest = translation.text;
      for (const [consumer, ids] of item.subscribers) {
        const output = recipients.get(consumer) ?? [];
        output.push(...ids.map((id) => ({ id, text: translation.text })));
        recipients.set(consumer, output);
      }
    }
    for (const [consumer, output] of recipients) this.progress(consumer, output);
  }

  private completeGroup(group: ProviderGroup, translations: Translation[]): void {
    if (!group.active) return;
    const expected = new Set(group.items.map((item) => item.id));
    if (!Array.isArray(translations) || translations.length !== expected.size || translations.some((translation) =>
      !translation || typeof translation.text !== "string" || !translation.text.trim() || !expected.delete(translation.id))) {
      this.failGroup(group, new AppError("INVALID_RESPONSE", "翻译结果不完整，请重试。"));
      return;
    }
    const result = new Map(translations.map((translation) => [translation.id, translation.text]));
    if (group.items.some(item => !preservesProtectedText(item.text, result.get(item.id)!))) {
      this.failGroup(group, new AppError("INVALID_RESPONSE", "译文未保留受保护内容，请重试。"));
      return;
    }
    group.active = false;
    const entries = group.items.filter((item) => item.text.length <= MAX_BATCH_CHARACTERS && this.versions.get(item.key) === item.version &&
      [...item.subscribers.keys()].some((consumer) => consumer.persist && this.enabled && consumer.epoch === this.epoch(item.origin)))
      .map((item) => ({ key: item.key, origin: item.origin, text: result.get(item.id)! }));
    // Enqueue the validated write before resolving consumers; a refresh's read follows it.
    if (entries.length) void this.cache.put(entries);
    for (const item of group.items) this.completeItem(item, result.get(item.id)!);
  }

  private completeItem(item: WorkItem, text: string): void {
    this.releaseItem(item);
    for (const [consumer, ids] of [...item.subscribers]) {
      consumer.links.delete(item);
      for (const id of ids) consumer.results.set(id, text);
      if (!consumer.ended && consumer.results.size === consumer.request.blocks.length) {
        consumer.ended = true;
        this.forgetConsumer(consumer);
        consumer.resolve(consumer.request.blocks.map((block) => ({ id: block.id, text: consumer.results.get(block.id)! })));
      }
    }
    item.subscribers.clear();
  }

  private failGroup(group: ProviderGroup, error: unknown): void {
    if (!group.active) return;
    group.active = false;
    const consumers = new Set(group.items.flatMap((item) => [...item.subscribers.keys()]));
    for (const consumer of consumers) this.failConsumer(consumer, error);
    for (const item of group.items) this.releaseItem(item);
  }

  private failConsumer(consumer: Consumer, error: unknown): void {
    if (consumer.ended) return;
    consumer.ended = true;
    this.forgetConsumer(consumer);
    const groups = new Set<ProviderGroup>();
    for (const item of consumer.links.keys()) {
      item.subscribers.delete(consumer);
      if (!item.subscribers.size) this.releaseItem(item);
      if (item.group) groups.add(item.group);
    }
    consumer.links.clear();
    consumer.reject(error);
    for (const group of groups) {
      if (group.active && group.items.every((item) => !item.subscribers.size)) {
        group.active = false;
        try { void Promise.resolve(this.provider.cancel(group.jobId, group.batchId)).catch(() => {}); }
        catch { /* Consumer cancellation is already settled, even if the transport is gone. */ }
      }
    }
  }

  private progress(consumer: Consumer, translations: Translation[]): void {
    if (consumer.ended) return;
    try { consumer.onProgress?.(translations); } catch { /* A closed page cannot break other subscribers. */ }
  }

  private link(consumer: Consumer, group: ProviderGroup): void {
    if (consumer.linkedGroups.has(group.batchId)) return;
    consumer.linkedGroups.add(group.batchId);
    try { this.options.onLink?.({ jobId: consumer.request.jobId, batchId: consumer.request.batchId, providerJobId: group.jobId, providerBatchId: group.batchId }); }
    catch { /* Diagnostic observers cannot affect translation. */ }
  }

  private releaseItem(item: WorkItem): void {
    if (this.inFlight.get(item.shareKey) === item) this.inFlight.delete(item.shareKey);
    if (![...this.inFlight.values()].some((active) => active.key === item.key)) this.versions.delete(item.key);
  }

  private forgetConsumer(consumer: Consumer): void {
    this.consumers.delete(this.identity(consumer.request.jobId, consumer.request.batchId));
    this.pruneOriginEpoch(consumer.request.origin);
  }

  private pruneOriginEpoch(origin: string): void {
    if (![...this.consumers.values()].some((consumer) => consumer.request.origin === origin)) this.originEpochs.delete(origin);
  }
}
