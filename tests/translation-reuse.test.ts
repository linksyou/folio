import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { TranslationCache, MemoryTranslationCacheStore } from "../src/extension/translation-cache.js";
import { TranslationReuse, type TranslationReuseProvider, type TranslationReuseRequest, type TranslationReuseLink } from "../src/extension/translation-reuse.js";
import type { Translation } from "../src/shared/protocol.js";

type ProviderRequest = Parameters<TranslationReuseProvider["translate"]>[0];
interface Call {
  request: ProviderRequest;
  progress: (translations: Translation[]) => void;
  resolve: (translations: Translation[]) => void;
  reject: (error: unknown) => void;
}
function harness() {
  const store = new MemoryTranslationCacheStore();
  const cache = new TranslationCache({ store });
  const calls: Call[] = [];
  const cancelled: string[] = [];
  const links: TranslationReuseLink[] = [];
  const provider: TranslationReuseProvider = {
    translate: (request, progress) => new Promise((resolve, reject) => calls.push({ request, progress, resolve, reject })),
    cancel: (jobId, batchId) => { cancelled.push(`${jobId}/${batchId}`); },
  };
  const reuse = new TranslationReuse(cache, provider, { onLink: (link) => links.push(link) });
  return { store, cache, calls, cancelled, provider, reuse, links };
}
function request(jobId: string, texts = ["Hello"], extra: Partial<TranslationReuseRequest> = {}): TranslationReuseRequest {
  return { jobId, batchId: "batch", settingsRevision: "settings", origin: "https://example.com", url: "https://example.com/article", blocks: texts.map((text, index) => ({ id: `${jobId}-${index}`, text })), ...extra };
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await setImmediate();
  assert.ok(condition(), "Expected asynchronous work to become available");
}
function finish(call: Call, prefix = "译：") {
  call.resolve(call.request.blocks.map((block) => ({ id: block.id, text: prefix + block.text })));
}

test("duplicate segments share one provider batch, preserve caller IDs and survive a new broker", async () => {
  const h = harness();
  const progress: Translation[][] = [];
  const pending = h.reuse.translate(request("one", ["Hello", "Hello", "World"]), (value) => progress.push(value));
  await until(() => h.calls.length === 1);
  assert.equal(h.calls[0].request.blocks.length, 2);
  assert.notEqual(h.calls[0].request.jobId, "one");
  const hello = h.calls[0].request.blocks.find((block) => block.text === "Hello")!;
  h.calls[0].progress([{ id: hello.id, text: "你" }]);
  assert.deepEqual(progress, [[{ id: "one-0", text: "你" }, { id: "one-1", text: "你" }]]);
  finish(h.calls[0]);
  assert.deepEqual(await pending, [{ id: "one-0", text: "译：Hello" }, { id: "one-1", text: "译：Hello" }, { id: "one-2", text: "译：World" }]);
  const reopened = new TranslationReuse(new TranslationCache({ store: h.store }), h.provider);
  assert.deepEqual(await reopened.translate(request("refresh", ["Hello", "World"])), [{ id: "refresh-0", text: "译：Hello" }, { id: "refresh-1", text: "译：World" }]);
  assert.equal(h.calls.length, 1);
  const records = await h.store.all();
  assert.equal(records.length, 2);
  assert.ok(records.every((entry) => /^[a-f0-9]{64}$/.test(entry.key)));
  assert.ok(!JSON.stringify(records).includes("/article"));
  assert.equal(h.links[0].jobId, "one");
});

test("late subscribers receive the latest preview and missing blocks keep their own multi-block request", async () => {
  const h = harness();
  const first = h.reuse.translate(request("one", ["shared", "only-one"]));
  const firstRejected = assert.rejects(first, { code: "CANCELLED" });
  await until(() => h.calls.length === 1);
  const shared = h.calls[0].request.blocks.find((block) => block.text === "shared")!;
  h.calls[0].progress([{ id: shared.id, text: "共享" }]);
  const secondProgress: Translation[][] = [];
  const second = h.reuse.translate(request("two", ["shared", "new-a", "new-b"]), (value) => secondProgress.push(value));
  await until(() => h.calls.length === 2);
  assert.deepEqual(secondProgress, [[{ id: "two-0", text: "共享" }]]);
  assert.deepEqual(h.calls[1].request.blocks.map((block) => block.text), ["new-a", "new-b"]);
  h.reuse.cancelJob("one");
  await firstRejected;
  assert.equal(h.cancelled.length, 0, "The shared provider batch still has a subscriber");
  finish(h.calls[0]);
  finish(h.calls[1]);
  assert.equal((await second).length, 3);
  assert.equal((await h.cache.stats()).entries, 3, "An unsubscribed sibling is not cached");
  const orphan = h.reuse.translate(request("orphan", ["only-one"]));
  await until(() => h.calls.length === 3);
  finish(h.calls[2]);
  await orphan;
});

test("a mixed cache hit previews immediately while only missing text waits on the provider", async () => {
  const h = harness();
  const seed = h.reuse.translate(request("seed", ["saved"]));
  await until(() => h.calls.length === 1);
  finish(h.calls[0]);
  await seed;
  const progress: Translation[][] = [];
  let complete = false;
  const mixed = h.reuse.translate(request("mixed", ["saved", "new"]), (value) => progress.push(value))
    .then((value) => { complete = true; return value; });
  await until(() => h.calls.length === 2);
  assert.deepEqual(h.calls[1].request.blocks.map((block) => block.text), ["new"]);
  assert.deepEqual(progress, [[{ id: "mixed-0", text: "译：saved" }]]);
  assert.equal(complete, false);
  finish(h.calls[1]);
  assert.deepEqual(await mixed, [{ id: "mixed-0", text: "译：saved" }, { id: "mixed-1", text: "译：new" }]);
});

test("last subscriber cancellation settles immediately and late provider output cannot cache or preview", async () => {
  const h = harness();
  const progress: unknown[] = [];
  const pending = h.reuse.translate(request("one"), (value) => progress.push(value));
  const rejected = assert.rejects(pending, { code: "CANCELLED" });
  await until(() => h.calls.length === 1);
  h.reuse.cancelBatch("one", "batch");
  await rejected;
  assert.equal(h.cancelled.length, 1);
  h.calls[0].progress([{ id: h.calls[0].request.blocks[0].id, text: "迟到" }]);
  finish(h.calls[0]);
  await setImmediate();
  assert.deepEqual(progress, []);
  assert.equal((await h.cache.stats()).entries, 0);
  const retry = h.reuse.translate(request("retry"));
  await until(() => h.calls.length === 2);
  finish(h.calls[1]);
  await retry;
});

test("cancelling before hashing or cache lookup finishes never starts a provider", async () => {
  const h = harness();
  const pending = h.reuse.translate(request("one"));
  const rejected = assert.rejects(pending, { code: "CANCELLED" });
  h.reuse.cancelJob("one");
  await rejected;
  for (let i = 0; i < 10; i++) await setImmediate();
  assert.equal(h.calls.length, 0);
});

for (const invalid of ["missing", "duplicate", "unknown", "empty"] as const) {
  test(`an invalid final batch (${invalid}) caches no partial success`, async () => {
    const h = harness();
    const pending = h.reuse.translate(request("one", ["a", "b"]));
    const rejected = assert.rejects(pending, { code: "INVALID_RESPONSE" });
    await until(() => h.calls.length === 1);
    const [a, b] = h.calls[0].request.blocks;
    h.calls[0].progress([{ id: a.id, text: "preview" }]);
    const translations = [{ id: a.id, text: "甲" }, { id: b.id, text: "乙" }];
    if (invalid === "missing") translations.pop();
    if (invalid === "duplicate") translations[1].id = a.id;
    if (invalid === "unknown") translations[1].id = "unknown";
    if (invalid === "empty") translations[1].text = "  ";
    h.calls[0].resolve(translations);
    await rejected;
    assert.equal((await h.cache.stats()).entries, 0);
  });
}

test("provider failure rejects every shared subscriber without caching previews", async () => {
  const h = harness();
  const first = h.reuse.translate(request("one"));
  const firstRejected = assert.rejects(first, /offline/);
  await until(() => h.calls.length === 1);
  const second = h.reuse.translate(request("two"));
  const secondRejected = assert.rejects(second, /offline/);
  await until(() => h.links.some((link) => link.jobId === "two"));
  h.calls[0].reject(new Error("offline"));
  await Promise.all([firstRejected, secondRejected]);
  assert.equal((await h.cache.stats()).entries, 0);
});

test("clearing an origin prevents old in-flight work from repopulating it", async () => {
  const h = harness();
  const old = h.reuse.translate(request("old"));
  await until(() => h.calls.length === 1);
  await h.reuse.clear("https://example.com");
  const fresh = h.reuse.translate(request("fresh"));
  await until(() => h.calls.length === 2);
  finish(h.calls[1], "new:");
  await fresh;
  finish(h.calls[0], "old:");
  await old;
  assert.deepEqual(await h.reuse.translate(request("cached")), [{ id: "cached-0", text: "new:Hello" }]);
  assert.equal(h.calls.length, 2);
});

test("disabling cache fences pending writes and disabling persistence still deduplicates within a job", async () => {
  const h = harness();
  const old = h.reuse.translate(request("old"));
  await until(() => h.calls.length === 1);
  h.reuse.setEnabled(false);
  finish(h.calls[0]);
  await old;
  assert.equal((await h.cache.stats()).entries, 0);
  const first = h.reuse.translate(request("job", ["same"], { batchId: "one" }));
  const second = h.reuse.translate(request("job", ["same"], { batchId: "two" }));
  await until(() => h.calls.length === 2 && h.links.filter((link) => link.jobId === "job").length === 2);
  finish(h.calls[1]);
  await Promise.all([first, second]);
  assert.equal((await h.cache.stats()).entries, 0);
});

test("per-request disabled persistence neither reads cache nor shares work between jobs", async () => {
  const h = harness();
  const seed = h.reuse.translate(request("seed"));
  await until(() => h.calls.length === 1); finish(h.calls[0]); await seed;
  const first = h.reuse.translate(request("one", ["Hello"], { enabled: false }));
  const second = h.reuse.translate(request("two", ["Hello"], { enabled: false }));
  await until(() => h.calls.length === 3);
  finish(h.calls[1]); finish(h.calls[2]);
  await Promise.all([first, second]);
  assert.equal((await h.cache.stats()).entries, 1);
});

test("force bypasses saved and older shared work but deduplicates inside the force job", async () => {
  const h = harness();
  const seed = h.reuse.translate(request("seed"));
  await until(() => h.calls.length === 1); finish(h.calls[0], "seed:"); await seed;
  const forced = h.reuse.translate(request("force", ["Hello"], { force: true, batchId: "one" }));
  const repeated = h.reuse.translate(request("force", ["Hello"], { force: true, batchId: "two" }));
  await until(() => h.calls.length === 2 && h.links.filter((link) => link.jobId === "force").length === 2);
  finish(h.calls[1], "forced:");
  await Promise.all([forced, repeated]);
  assert.deepEqual(await h.reuse.translate(request("cached")), [{ id: "cached-0", text: "forced:Hello" }]);
  assert.equal(h.calls.length, 2);
});

test("an older pending result cannot overwrite a newer forced result", async () => {
  const h = harness();
  const old = h.reuse.translate(request("old"));
  await until(() => h.calls.length === 1);
  const forced = h.reuse.translate(request("force", ["Hello"], { force: true }));
  await until(() => h.calls.length === 2);
  finish(h.calls[1], "forced:"); await forced;
  finish(h.calls[0], "old:"); await old;
  assert.deepEqual(await h.reuse.translate(request("cached")), [{ id: "cached-0", text: "forced:Hello" }]);
});

test("reading an old cache entry during force regeneration cannot suppress the replacement write", async () => {
  const h = harness();
  const seed = h.reuse.translate(request("seed"));
  await until(() => h.calls.length === 1); finish(h.calls[0], "seed:"); await seed;
  const forced = h.reuse.translate(request("force", ["Hello"], { force: true }));
  await until(() => h.calls.length === 2);
  assert.deepEqual(await h.reuse.translate(request("during")), [{ id: "during-0", text: "seed:Hello" }]);
  finish(h.calls[1], "forced:"); await forced;
  assert.deepEqual(await h.reuse.translate(request("after")), [{ id: "after-0", text: "forced:Hello" }]);
});

test("clearing one site leaves another site's active result cacheable", async () => {
  const h = harness();
  const first = h.reuse.translate(request("one"));
  const second = h.reuse.translate(request("two", ["Hello"], { origin: "https://another.test", url: "https://another.test/page" }));
  await until(() => h.calls.length === 2);
  await h.reuse.clear("https://example.com");
  for (const call of h.calls) finish(call);
  await Promise.all([first, second]);
  assert.deepEqual((await h.reuse.stats()).origins, ["https://another.test"]);
});

test("synchronous provider and cancellation errors do not orphan consumers", async () => {
  const cache = new TranslationCache({ store: new MemoryTranslationCacheStore() });
  const broken = new TranslationReuse(cache, { translate: () => { throw new Error("failed before request"); }, cancel: () => {} });
  await assert.rejects(broken.translate(request("broken")), /failed before request/);
  let started = false;
  const disconnected = new TranslationReuse(cache, {
    translate: () => { started = true; return new Promise(() => {}); },
    cancel: () => { throw new Error("port closed"); },
  });
  const pending = disconnected.translate(request("cancel"));
  const rejected = assert.rejects(pending, { code: "CANCELLED" });
  await until(() => started);
  disconnected.cancelJob("cancel");
  await rejected;
  assert.equal((await cache.stats()).entries, 0);
});

test("different full URLs and generation revisions cannot reuse a translation", async () => {
  const h = harness();
  const seed = h.reuse.translate(request("seed"));
  await until(() => h.calls.length === 1); finish(h.calls[0]); await seed;
  const revision = h.reuse.translate(request("revision", ["Hello"], { settingsRevision: "new-settings" }));
  const url = h.reuse.translate(request("url", ["Hello"], { url: "https://example.com/another?query=private" }));
  await until(() => h.calls.length === 3);
  finish(h.calls[1]); finish(h.calls[2]);
  await Promise.all([revision, url]);
  assert.equal((await h.cache.stats()).entries, 3);
  assert.ok(!JSON.stringify(await h.store.all()).includes("query=private"));
});

test("oversized source or output is delivered but never cached", async () => {
  const h = harness();
  const source = h.reuse.translate(request("source", ["a".repeat(4_001)]));
  await until(() => h.calls.length === 1); finish(h.calls[0]); await source;
  const output = h.reuse.translate(request("output"));
  await until(() => h.calls.length === 2);
  h.calls[1].resolve([{ id: h.calls[1].request.blocks[0].id, text: "x".repeat(32_001) }]);
  await output;
  assert.equal((await h.cache.stats()).entries, 0);
});
