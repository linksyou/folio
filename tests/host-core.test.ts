import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError } from "../src/shared/errors.js";
import { encodeMessage, MessageDecoder } from "../src/host/framing.js";
import { RequestQueue } from "../src/host/queue.js";
import { normalizeBaseUrl, publicSettings, SettingsStore } from "../src/host/settings.js";
import { validateCommand } from "../src/shared/validation.js";
import { createProgressCoalescer } from "../src/host/stream-translations.js";
import type { Translation } from "../src/shared/protocol.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function expectCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

test("request queue enforces its concurrency limit and starts queued work FIFO", async () => {
  const queue = new RequestQueue(2);
  const controls = Array.from({ length: 4 }, () => ({ entered: deferred(), release: deferred() }));
  const order: number[] = [];
  let active = 0;
  let maximum = 0;
  const runs = controls.map((control, id) => queue.run(new AbortController().signal, async () => {
    order.push(id);
    active += 1;
    maximum = Math.max(maximum, active);
    control.entered.resolve();
    await control.release.promise;
    active -= 1;
    return id;
  }));

  await Promise.all([controls[0]!.entered.promise, controls[1]!.entered.promise]);
  assert.deepEqual(order, [0, 1]);
  assert.equal(active, 2);
  controls[0]!.release.resolve();
  controls[1]!.release.resolve();
  await Promise.all([controls[2]!.entered.promise, controls[3]!.entered.promise]);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.equal(maximum, 2);
  controls[2]!.release.resolve();
  controls[3]!.release.resolve();
  assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3]);
});

test("cancelling queued work removes it without consuming the next queue slot", async () => {
  const queue = new RequestQueue(1);
  const first = { entered: deferred(), release: deferred() };
  const thirdEntered = deferred();
  let cancelledStarted = false;
  const firstRun = queue.run(new AbortController().signal, async () => {
    first.entered.resolve();
    await first.release.promise;
    return "first";
  });
  await first.entered.promise;

  const controller = new AbortController();
  const cancelled = queue.run(controller.signal, async () => {
    cancelledStarted = true;
    return "cancelled";
  });
  const cancelledCheck = assert.rejects(cancelled, expectCode("CANCELLED"));
  const third = queue.run(new AbortController().signal, async () => {
    thirdEntered.resolve();
    return "third";
  });
  controller.abort();
  await cancelledCheck;
  first.release.resolve();

  assert.equal(await firstRun, "first");
  await thirdEntered.promise;
  assert.equal(await third, "third");
  assert.equal(cancelledStarted, false);
});

test("native-message decoder handles split and coalesced frames", () => {
  const first = encodeMessage({ id: 1, text: "中文" });
  const second = encodeMessage(["two", 2]);
  const decoder = new MessageDecoder();
  const output: unknown[] = [];

  for (const byte of first.subarray(0, first.length - 1)) {
    output.push(...decoder.push(Buffer.from([byte])));
  }
  assert.deepEqual(output, []);
  assert.equal(decoder.hasPartialMessage, true);
  const completed = decoder.push(Buffer.concat([first.subarray(first.length - 1), second]));
  assert.deepEqual(completed, [{ id: 1, text: "中文" }, ["two", 2]]);
  assert.equal(decoder.hasPartialMessage, false);
});

test("native-message decoder rejects zero, oversized, and invalid JSON frames", () => {
  const zero = Buffer.alloc(4);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(1_048_577);
  const malformed = Buffer.alloc(5);
  malformed.writeUInt32LE(1);
  malformed[4] = "{".charCodeAt(0);

  for (const frame of [zero, oversized, malformed]) {
    assert.throws(() => new MessageDecoder().push(frame), expectCode("INVALID_REQUEST"));
  }
});

test("settings preserve an omitted key, clear an explicit empty key, normalize URLs, and change revision", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "open-web-translator-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory);

  const first = await store.save({
    provider: "custom",
    chatgptModel: "  chat-model  ",
    customBaseUrl: "  https://EXAMPLE.test/v1///  ",
    customModel: "  custom-model  ",
    apiKey: "  first-secret  ",
  });
  assert.equal(first.chatgptModel, "chat-model");
  assert.equal(first.customBaseUrl, "https://example.test/v1");
  assert.equal(first.customModel, "custom-model");
  assert.equal(first.apiKey, "first-secret");

  const preserved = await store.save({
    provider: "custom",
    chatgptModel: first.chatgptModel,
    customBaseUrl: first.customBaseUrl,
    customModel: first.customModel,
  });
  assert.equal(preserved.apiKey, "first-secret");
  assert.equal(preserved.revision, first.revision, "saving the normalized generation settings again preserves their identity");
  assert.deepEqual(publicSettings(preserved), {
    provider: "custom",
    chatgptModel: "chat-model",
    customBaseUrl: "https://example.test/v1",
    customModel: "custom-model",
    chatgptReasoningEffort: "auto",
    customReasoningEffort: "auto",
    targetLanguage: "zh-CN",
    displayMode: "bilingual",
    hasApiKey: true,
  });

  const cleared = await store.save({
    provider: "custom",
    chatgptModel: preserved.chatgptModel,
    customBaseUrl: preserved.customBaseUrl,
    customModel: preserved.customModel,
    apiKey: "",
  });
  assert.equal(cleared.apiKey, "");
  assert.equal(publicSettings(cleared).hasApiKey, false);
  assert.notEqual(cleared.revision, preserved.revision);
});

test("presentation-only saves preserve the generation revision while language and reasoning changes replace it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "open-web-translator-display-revision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory);
  const input = { provider: "custom" as const, chatgptModel: "", customBaseUrl: "https://custom.test/v1", customModel: "model" };
  const first = await store.save(input);
  const displayed = await store.save({ ...input, displayMode: "translation-only" });
  assert.equal(displayed.revision, first.revision);
  assert.equal((await store.read()).displayMode, "translation-only", "legacy preference remains readable for browser migration");
  const language = await store.save({ ...input, targetLanguage: "ja" });
  assert.notEqual(language.revision, displayed.revision);
  const reasoning = await store.save({ ...input, customReasoningEffort: "low" });
  assert.notEqual(reasoning.revision, language.revision);
});

test("settings migrate missing reasoning fields to auto and preserve choices omitted by older callers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "open-web-translator-settings-reasoning-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "settings.json"), JSON.stringify({
    provider: "chatgpt",
    chatgptModel: "gpt-6-sol",
    customBaseUrl: "https://example.test/v1",
    customModel: "custom",
    apiKey: "",
    revision: "old",
  }));
  const store = new SettingsStore(directory);
  const migrated = await store.read();
  assert.equal(migrated.chatgptReasoningEffort, "auto");
  assert.equal(migrated.customReasoningEffort, "auto");
  assert.equal(migrated.targetLanguage, "zh-CN");
  assert.equal(migrated.displayMode, "bilingual");

  const selected = await store.save({
    provider: "chatgpt",
    chatgptModel: "gpt-6-sol",
    customBaseUrl: "https://example.test/v1",
    customModel: "custom",
    chatgptReasoningEffort: "low",
    customReasoningEffort: "high",
    targetLanguage: "ja",
    displayMode: "translation-only",
  });
  const preserved = await store.save({
    provider: "chatgpt",
    chatgptModel: selected.chatgptModel,
    customBaseUrl: selected.customBaseUrl,
    customModel: selected.customModel,
  });
  assert.equal(preserved.chatgptReasoningEffort, "low");
  assert.equal(preserved.customReasoningEffort, "high");
  assert.equal(preserved.targetLanguage, "ja");
  assert.equal(preserved.displayMode, "translation-only");
  assert.equal((await store.read()).targetLanguage, "ja");
  assert.equal((await store.read()).displayMode, "translation-only");
});

test("settings default and validate target language and display mode", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "open-web-translator-language-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory);
  const initial = await store.read();
  assert.equal(initial.targetLanguage, "zh-CN");
  assert.equal(initial.displayMode, "bilingual");
  for (const invalid of [{ targetLanguage: "unknown" }, { displayMode: "unknown" }]) {
    const input = { ...initial, ...invalid };
    assert.throws(() => validateCommand({ type: "settings.save", settings: input }), expectCode("INVALID_REQUEST"));
    await assert.rejects(store.save(input as unknown as Parameters<SettingsStore["save"]>[0]), expectCode("INVALID_CONFIG"));
  }
});

test("progress coalescing preserves each id and sends the latest trailing snapshot", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: Translation[][] = [];
  const stream = createProgressCoalescer((items) => sent.push(items));
  stream.push([{ id: "first", text: "一" }]);
  stream.push([{ id: "second", text: "二" }]);
  stream.push([{ id: "first", text: "一段" }]);
  assert.deepEqual(sent, [[{ id: "first", text: "一" }]]);
  t.mock.timers.tick(40);
  assert.deepEqual(sent[1], [{ id: "first", text: "一段" }, { id: "second", text: "二" }]);
  stream.push([{ id: "second", text: "二" }]);
  t.mock.timers.tick(40);
  assert.equal(sent.length, 2, "unchanged snapshots do not schedule IPC");
  stream.close();
});

test("closing progress after cancellation or terminal removes pending trailing output", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: Translation[][] = [];
  const stream = createProgressCoalescer((items) => sent.push(items));
  stream.push([{ id: "first", text: "一" }]);
  stream.push([{ id: "second", text: "二" }]);
  stream.close();
  t.mock.timers.tick(100);
  stream.push([{ id: "first", text: "late" }]);
  stream.flush();
  assert.deepEqual(sent, [[{ id: "first", text: "一" }]]);
});

test("settings validation accepts documented choices and rejects unknown effort strings", () => {
  const base = {
    provider: "chatgpt",
    chatgptModel: "gpt-6-sol",
    customBaseUrl: "",
    customModel: "",
  };
  assert.doesNotThrow(() => validateCommand({
    type: "settings.save", settings: { ...base, chatgptReasoningEffort: "ultra" },
  }));
  assert.throws(() => validateCommand({
    type: "settings.save", settings: { ...base, customReasoningEffort: "turbo" },
  }), expectCode("INVALID_REQUEST"));
});

test("base URL normalization allows HTTPS and loopback HTTP but rejects unsafe or endpoint URLs", () => {
  assert.equal(normalizeBaseUrl("https://Example.COM/v1///"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8787/v1/"), "http://127.0.0.1:8787/v1");
  assert.equal(normalizeBaseUrl("http://[::1]:8787/v1"), "http://[::1]:8787/v1");

  for (const value of [
    "http://example.com/v1",
    "https://user:password@example.com/v1",
    "https://example.com/v1?key=secret",
    "https://example.com/v1#fragment",
    "https://example.com/v1/chat/completions",
    "https://example.com/v1/responses/",
  ]) {
    assert.throws(() => normalizeBaseUrl(value), expectCode("INVALID_CONFIG"));
  }
});
