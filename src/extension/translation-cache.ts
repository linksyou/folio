import { AppError } from "../shared/errors.js";

/** Only hashes, translated text and the owning origin are persisted. */
export interface TranslationCacheEntry {
  key: string;
  origin: string;
  text: string;
  createdAt: number;
  accessedAt: number;
  bytes: number;
}

export interface TranslationCacheStore {
  get(key: string): Promise<TranslationCacheEntry | undefined>;
  all(): Promise<TranslationCacheEntry[]>;
  write(entries: TranslationCacheEntry[]): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

/** Useful for deterministic tests and ephemeral contexts; production uses IndexedDB. */
export class MemoryTranslationCacheStore implements TranslationCacheStore {
  private entries = new Map<string, TranslationCacheEntry>();
  async get(key: string) { const entry = this.entries.get(key); return entry && { ...entry }; }
  async all() { return [...this.entries.values()].map((entry) => ({ ...entry })); }
  async write(entries: TranslationCacheEntry[]) { for (const entry of entries) this.entries.set(entry.key, { ...entry }); }
  async delete(keys: string[]) { for (const key of keys) this.entries.delete(key); }
}

class IndexedDbTranslationCacheStore implements TranslationCacheStore {
  private database?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
      const request = indexedDB.open("open-web-translator-translations", 1);
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error("Cache open timed out")); }, 1_000);
      request.onupgradeneeded = () => { request.result.createObjectStore("translations", { keyPath: "key" }); };
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (expired) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }

  private async transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("translations", mode);
      const timer = setTimeout(() => {
        try { transaction.abort(); } catch { /* Completion may already be queued. */ }
        reject(new Error("Cache transaction timed out"));
      }, 1_000);
      let request: IDBRequest<T>;
      try { request = run(transaction.objectStore("translations")); }
      catch (error) { clearTimeout(timer); transaction.abort(); reject(error); return; }
      transaction.oncomplete = () => { clearTimeout(timer); resolve(request.result); };
      transaction.onerror = transaction.onabort = () => { clearTimeout(timer); reject(transaction.error); };
    });
  }

  get(key: string) { return this.transaction<TranslationCacheEntry | undefined>("readonly", (store) => store.get(key)); }
  all() { return this.transaction<TranslationCacheEntry[]>("readonly", (store) => store.getAll()); }
  async write(entries: TranslationCacheEntry[]) {
    if (entries.length) await this.transaction("readwrite", (store) => {
      for (const entry of entries.slice(0, -1)) store.put(entry);
      return store.put(entries.at(-1)!);
    });
  }
  async delete(keys: string[]) {
    if (keys.length) await this.transaction("readwrite", (store) => {
      for (const key of keys.slice(0, -1)) store.delete(key);
      return store.delete(keys.at(-1)!);
    });
  }
}

export interface TranslationCacheOptions {
  store?: TranslationCacheStore;
  now?: () => number;
  ttlMs?: number;
  maxBytes?: number;
  maxEntries?: number;
}

export class TranslationCache {
  private readonly store: TranslationCacheStore;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private queue: Promise<unknown> = Promise.resolve();
  private unavailable = false;

  constructor(options: TranslationCacheOptions = {}) {
    this.store = options.store ?? new IndexedDbTranslationCacheStore();
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60_000;
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 2_000;
  }

  /** Serialization also orders a clear after any write that had already started. */
  private operation<T>(fallback: T, run: () => Promise<T>, required = false): Promise<T> {
    const operation = this.queue.then(async () => {
      if (this.unavailable) {
        if (required) throw new AppError("CACHE_UNAVAILABLE", "本地缓存无法访问，未能确认清除结果，请重新加载扩展后重试。");
        return fallback;
      }
      try { return await run(); }
      catch {
        this.unavailable = true;
        if (required) throw new AppError("CACHE_UNAVAILABLE", "本地缓存无法访问，未能确认清除结果，请重新加载扩展后重试。");
        return fallback;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  get(key: string): Promise<string | undefined> {
    return this.operation(undefined, async () => {
      const entry = await this.store.get(key);
      if (!entry) return undefined;
      if (this.now() - entry.createdAt >= this.ttlMs) { await this.store.delete([key]); return undefined; }
      await this.store.write([{ ...entry, accessedAt: this.now() }]);
      return entry.text;
    });
  }

  put(entries: Array<{ key: string; origin: string; text: string }>): Promise<void> {
    return this.operation(undefined, async () => {
      const now = this.now();
      const encoder = new TextEncoder();
      const accepted = entries.flatMap((entry) => {
        // Bound individual output independently of the total cache budget.
        if (!entry.text.trim() || entry.text.length > 32_000 || entry.key.length > 128 || entry.origin.length > 2_048) return [];
        const bytes = encoder.encode(entry.key + entry.origin + entry.text).byteLength + 64;
        return bytes <= this.maxBytes ? [{ ...entry, createdAt: now, accessedAt: now, bytes }] : [];
      });
      if (accepted.length) await this.store.write(accepted);
      await this.prune();
    });
  }

  clear(origin?: string): Promise<void> {
    return this.operation(undefined, async () => {
      const entries = await this.store.all();
      await this.store.delete(entries.filter((entry) => origin === undefined || entry.origin === origin).map((entry) => entry.key));
    }, true);
  }

  stats(): Promise<{ entries: number; bytes: number; origins: string[]; available?: boolean }> {
    return this.operation<{ entries: number; bytes: number; origins: string[]; available?: boolean }>({ entries: 0, bytes: 0, origins: [], available: false }, async () => {
      const entries = await this.prune();
      return {
        entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        origins: [...new Set(entries.map((entry) => entry.origin))].sort(),
      };
    });
  }

  private async prune(): Promise<TranslationCacheEntry[]> {
    const now = this.now();
    const entries = (await this.store.all()).sort((a, b) => b.accessedAt - a.accessedAt || b.createdAt - a.createdAt);
    const retained: TranslationCacheEntry[] = [];
    const discarded: string[] = [];
    let bytes = 0;
    for (const entry of entries) {
      if (now - entry.createdAt >= this.ttlMs || retained.length >= this.maxEntries || bytes + entry.bytes > this.maxBytes) discarded.push(entry.key);
      else { retained.push(entry); bytes += entry.bytes; }
    }
    if (discarded.length) await this.store.delete(discarded);
    return retained;
  }
}
