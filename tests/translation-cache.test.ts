import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTranslationCacheStore, TranslationCache, type TranslationCacheStore } from "../src/extension/translation-cache.js";

test("cache survives a new owner without persisting original URLs or source text", async () => {
  const store = new MemoryTranslationCacheStore();
  const first = new TranslationCache({ store });
  await first.put([{ key: "a".repeat(64), origin: "https://example.com", text: "你好" }]);
  const second = new TranslationCache({ store });
  assert.equal(await second.get("a".repeat(64)), "你好");
  assert.deepEqual(Object.keys((await store.all())[0]).sort(), ["accessedAt", "bytes", "createdAt", "key", "origin", "text"]);
  assert.equal((await second.stats()).entries, 1);
});

test("TTL expires from creation and a cache hit refreshes LRU without extending expiry", async () => {
  let now = 0;
  const cache = new TranslationCache({ store: new MemoryTranslationCacheStore(), now: () => now, ttlMs: 100, maxEntries: 2 });
  await cache.put([{ key: "a", origin: "https://a.test", text: "甲" }]);
  now = 10;
  await cache.put([{ key: "b", origin: "https://a.test", text: "乙" }]);
  now = 20;
  assert.equal(await cache.get("a"), "甲");
  now = 30;
  await cache.put([{ key: "c", origin: "https://a.test", text: "丙" }]);
  assert.equal(await cache.get("b"), undefined);
  now = 100;
  assert.equal(await cache.get("a"), undefined);
  assert.deepEqual((await cache.stats()).entries, 1);
});

test("cache respects the byte budget, rejects oversized output and clears one origin", async () => {
  let now = 0;
  const store = new MemoryTranslationCacheStore();
  const cache = new TranslationCache({ store, now: () => now++, maxBytes: 180 });
  await cache.put([{ key: "a", origin: "https://a.test", text: "甲".repeat(10) }]);
  await cache.put([{ key: "b", origin: "https://b.test", text: "乙".repeat(10) }]);
  assert.equal((await cache.stats()).entries, 1);
  assert.equal(await cache.get("a"), undefined);
  await cache.put([{ key: "huge", origin: "https://a.test", text: "x".repeat(32_001) }]);
  assert.equal((await cache.stats()).entries, 1);
  await cache.clear("https://a.test");
  assert.equal(await cache.get("b"), "乙".repeat(10));
  await cache.clear("https://b.test");
  assert.deepEqual(await cache.stats(), { entries: 0, bytes: 0, origins: [] });
});

test("clearing all entries is ordered after an already queued write", async () => {
  const cache = new TranslationCache({ store: new MemoryTranslationCacheStore() });
  const write = cache.put([{ key: "a", origin: "https://a.test", text: "甲" }]);
  const clear = cache.clear();
  await Promise.all([write, clear]);
  assert.deepEqual(await cache.stats(), { entries: 0, bytes: 0, origins: [] });
});

test("unavailable storage does not make translation reads or writes fail", async () => {
  let calls = 0;
  const fail = async () => { calls++; throw new Error("Storage denied"); };
  const store: TranslationCacheStore = { get: fail, all: fail, write: fail, delete: fail };
  const cache = new TranslationCache({ store });
  assert.equal(await cache.get("a"), undefined);
  await cache.put([{ key: "a", origin: "https://a.test", text: "甲" }]);
  await assert.rejects(cache.clear(), { code: "CACHE_UNAVAILABLE" });
  assert.deepEqual(await cache.stats(), { entries: 0, bytes: 0, origins: [], available: false });
  assert.equal(calls, 1, "Failed storage is not retried on every translated paragraph");
});

test("missing IndexedDB is a cache miss instead of a translation failure", async () => {
  const cache = new TranslationCache();
  assert.equal(await cache.get("not-stored"), undefined);
  await cache.put([{ key: "a", origin: "https://a.test", text: "甲" }]);
  assert.equal((await cache.stats()).entries, 0);
});

test("cache statistics expose a sorted distinct origin list for selective clearing", async () => {
  const cache = new TranslationCache({ store: new MemoryTranslationCacheStore() });
  await cache.put([
    { key: "a", origin: "https://b.test", text: "甲" },
    { key: "b", origin: "https://a.test", text: "乙" },
    { key: "c", origin: "https://b.test", text: "丙" },
  ]);
  assert.deepEqual((await cache.stats()).origins, ["https://a.test", "https://b.test"]);
  await cache.clear("https://b.test");
  assert.deepEqual((await cache.stats()).origins, ["https://a.test"]);
});
