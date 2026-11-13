import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryTranslationCacheStore, TranslationCache, type TranslationCacheStore } from "../src/extension/translation-cache.js";
import { TranslationReuse } from "../src/extension/translation-reuse.js";
import type { Translation } from "../src/shared/protocol.js";

const origin = "https://fixture.test";
const keys = (length: number, start = 0) => Array.from({ length }, (_, i) => String(start + i));
const entry = (key: string) => ({ key, origin, text: `translation-${key}` });

function fixture(batched: boolean) {
  const memory = new MemoryTranslationCacheStore();
  const reads: string[][] = [];
  const store: TranslationCacheStore = {
    async get(key) { reads.push([key]); return memory.get(key); },
    all: () => memory.all(),
    write: entries => memory.write(entries),
    delete: keys => memory.delete(keys),
  };
  if (batched) store.getMany = async keys => {
    reads.push(keys);
    return Promise.all(keys.map(key => memory.get(key)));
  };
  return { cache: new TranslationCache({ store }), reads };
}

for (const batched of [false, true]) {
  const mode = batched ? "batch storage" : "single-key storage";

  for (const warmCount of [255, 256, 257]) {
    test(`${mode}: mixed hits survive LRU updates after ${warmCount} warm reads`, async () => {
      const { cache, reads } = fixture(batched);
      await cache.put(keys(warmCount + 1).map(entry));
      await cache.getMany(keys(warmCount));
      reads.length = 0;

      const oldestHot = Math.max(0, warmCount - 256);
      const requested = [String(warmCount), String(oldestHot), String(oldestHot + 1)];
      assert.deepEqual([...await cache.getMany(requested)], requested.map(key => [key, entry(key).text]));
      assert.deepEqual(reads, [[String(warmCount)]], "only the cold entry needs storage");
    });
  }

  test(`${mode}: a batch larger than the hot cache preserves hits, duplicates and misses`, async () => {
    const { cache, reads } = fixture(batched);
    await cache.put(keys(600).map(entry));
    await cache.getMany(keys(256));
    reads.length = 0;
    const requested = [...keys(344, 256), ...keys(256), "0", "missing", "missing"];
    const result = await cache.getMany(requested);

    assert.equal(result.size, 600);
    for (const key of keys(600)) assert.equal(result.get(key), entry(key).text);
    assert.equal(result.has("missing"), false);
    assert.deepEqual(reads.flat(), [...keys(344, 256), "missing"], "read each cold key once");
    if (batched) assert.equal(reads.length, 1, "keep a single storage batch");

    reads.length = 0;
    assert.equal(await cache.get("255"), entry("255").text);
    assert.equal(await cache.get("256"), entry("256").text);
    assert.deepEqual(reads.flat(), ["256"], "retain recent entries but keep the hot cache bounded");
  });

  test(`${mode}: a fully cached mixed batch succeeds with the provider unavailable`, async () => {
    const { cache } = fixture(batched);
    let providerCalls = 0;
    let unavailable = false;
    const reuse = new TranslationReuse(cache, {
      async translate(request) {
        providerCalls++;
        if (unavailable) throw new Error("Fixture provider unavailable");
        return request.blocks.map(block => ({ id: block.id, text: `translated ${block.text}` }));
      },
      cancel() {},
    });
    let sequence = 0;
    const translate = (ids: string[], onProgress?: (translations: Translation[]) => void) => reuse.translate({
      jobId: "cache-batch", batchId: String(++sequence), settingsRevision: "r1",
      origin, url: `${origin}/document`,
      blocks: ids.map(id => ({ id, text: `Paragraph ${id}. A cached sentence.` })),
    }, onProgress);

    await translate(keys(257));
    await translate(keys(256));
    assert.equal(providerCalls, 1);
    unavailable = true;
    providerCalls = 0;
    const progress: Translation[] = [];
    const requested = ["256", "0", "1"];
    const result = await translate(requested, translations => progress.push(...translations));
    assert.deepEqual(result, requested.map(id => ({ id, text: `translated Paragraph ${id}. A cached sentence.` })));
    assert.deepEqual(progress, result, "all cached translations are also delivered as progress");
    assert.equal(providerCalls, 0, "a fully cached batch must not reach the provider");
    assert.equal((await cache.stats()).entries, 257);

    await assert.rejects(translate(["uncached"]), /Fixture provider unavailable/);
    assert.equal(providerCalls, 1, "a real miss still reports the provider failure");
  });
}
