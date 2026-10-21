import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import type { ExtensionRequest, Result } from "../src/shared/protocol.js";
import type { CacheStatus } from "../src/extension/cache-settings.js";
import { initializeTranslationCache } from "../src/extension/options-cache.js";

const html = readFile(new URL("../src/extension/options.html", import.meta.url), "utf8");
const initial: CacheStatus = {
  enabled: true, entries: 3, bytes: 2048, origins: ["https://first.test", "https://second.test"],
};
const ok = (value: CacheStatus): Result<CacheStatus> => ({ ok: true, result: structuredClone(value) });
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

async function mount(t: TestContext, respond: (message: ExtensionRequest) => Promise<unknown>, source?: string) {
  const dom = new JSDOM(source ?? await html, { url: "https://extension.test/options.html" });
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const messages: ExtensionRequest[] = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: {
    sendMessage(message: ExtensionRequest) {
      messages.push(message);
      assert.ok(message.type.startsWith("cache."), "cache controls must not contact the host or start model work");
      return respond(message);
    },
  } } });
  t.after(() => {
    dom.window.close();
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (oldChrome) Object.defineProperty(globalThis, "chrome", oldChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  });
  initializeTranslationCache();
  const document = dom.window.document;
  return {
    dom, messages,
    enabled: document.querySelector<HTMLInputElement>("#cache-enabled")!,
    origins: document.querySelector<HTMLSelectElement>("#cache-origin")!,
    summary: document.querySelector<HTMLElement>("#cache-summary")!,
    status: document.querySelector<HTMLElement>("#cache-status")!,
    clearSite: document.querySelector<HTMLButtonElement>("#cache-clear-site")!,
    clearAll: document.querySelector<HTMLButtonElement>("#cache-clear-all")!,
    change(element: HTMLElement) { element.dispatchEvent(new dom.window.Event("change")); },
  };
}

test("cache settings load browser statistics and remain independent of offline host controls", async (t) => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  const ui = await mount(t, async () => pending);
  assert.deepEqual(ui.messages, [{ type: "cache.status" }]);
  for (const control of [ui.enabled, ui.origins, ui.clearSite, ui.clearAll]) assert.equal(control.disabled, true);
  assert.equal(ui.enabled.closest("#host-controls"), null);
  assert.equal(ui.dom.window.document.querySelector<HTMLFieldSetElement>("#host-controls")!.disabled, true);
  finish(ok({ ...initial, enabled: false }));
  await settle();
  assert.equal(ui.enabled.checked, false);
  assert.equal(ui.enabled.disabled, false);
  assert.equal(ui.clearSite.disabled, false);
  assert.match(ui.summary.textContent!, /3 条译文.*2\.0 KiB.*2 个网站/);
  assert.deepEqual([...ui.origins.options].map((option) => option.value), initial.origins);
  assert.equal(ui.status.textContent, "", "normal loading does not repeat the static cache description");
  assert.match(ui.dom.window.document.querySelector("#cache-settings")!.textContent!, /译文可能含私人信息/);
  assert.equal(ui.messages.length, 1);
});

test("cache toggle is single-flight and changes only persistence preference", async (t) => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  const ui = await mount(t, async (message) => message.type === "cache.set" && !message.enabled
    ? pending : ok(initial));
  await settle();
  ui.origins.value = initial.origins[1];
  ui.enabled.checked = false;
  ui.change(ui.enabled);
  ui.clearAll.click();
  ui.clearSite.click();
  assert.equal(ui.enabled.disabled, true);
  assert.deepEqual(ui.messages, [{ type: "cache.status" }, { type: "cache.set", enabled: false }]);
  finish(ok({ ...initial, enabled: false }));
  await settle();
  assert.equal(ui.enabled.checked, false);
  assert.equal(ui.origins.value, initial.origins[1], "the selected site survives a preference update");
  assert.match(ui.status.textContent!, /已停用缓存/);
  assert.match(ui.summary.textContent!, /3 条译文/);
  ui.enabled.checked = true;
  ui.change(ui.enabled);
  await settle();
  assert.deepEqual(ui.messages.at(-1), { type: "cache.set", enabled: true });
  assert.match(ui.status.textContent!, /已启用缓存/);
});

test("unreadable cache is unknown rather than empty and disabling still succeeds", async (t) => {
  const ui = await mount(t, async (message) => ok({
    entries: 0, bytes: 0, origins: [], available: false,
    enabled: message.type === "cache.set" ? message.enabled : true,
  }));
  await settle();
  assert.match(ui.summary.textContent!, /数量未知/);
  assert.doesNotMatch(ui.summary.textContent!, /0 条译文/);
  ui.enabled.checked = false;
  ui.change(ui.enabled);
  await settle();
  assert.equal(ui.enabled.checked, false);
  assert.match(ui.status.textContent!, /已停用缓存/);
});

test("site clearing uses the selected origin and clearing all removes the remaining site list", async (t) => {
  const ui = await mount(t, async (message) => {
    if (message.type !== "cache.clear") return ok(initial);
    return message.origin
      ? ok({ ...initial, entries: 1, bytes: 512, origins: [initial.origins[0]] })
      : ok({ ...initial, entries: 0, bytes: 0, origins: [] });
  });
  await settle();
  ui.origins.value = initial.origins[1];
  ui.change(ui.origins);
  ui.clearSite.click();
  await settle();
  assert.deepEqual(ui.messages.at(-1), { type: "cache.clear", origin: initial.origins[1] });
  assert.deepEqual([...ui.origins.options].map((option) => option.value), [initial.origins[0]]);
  assert.match(ui.summary.textContent!, /1 条译文/);
  assert.match(ui.status.textContent!, /已清除此网站/);
  ui.clearAll.click();
  await settle();
  assert.deepEqual(ui.messages.at(-1), { type: "cache.clear" });
  assert.equal(ui.origins.options.length, 0);
  assert.equal(ui.clearSite.disabled, true);
  assert.equal(ui.origins.disabled, true);
  assert.match(ui.summary.textContent!, /0 条译文/);
  assert.match(ui.status.textContent!, /已清除全部缓存/);
});

test("failed cache operations retain known data, undo a failed toggle and never claim successful clearing", async (t) => {
  const ui = await mount(t, async (message) => message.type === "cache.status" ? ok(initial)
    : { ok: false, error: { code: "CACHE_UNAVAILABLE", message: "缓存无法访问，未能确认清除结果。" } });
  await settle();
  const summary = ui.summary.textContent;
  ui.clearSite.click();
  await settle();
  assert.equal(ui.summary.textContent, summary);
  assert.deepEqual([...ui.origins.options].map((option) => option.value), initial.origins);
  assert.match(ui.status.textContent!, /未能确认清除结果/);
  assert.doesNotMatch(ui.status.textContent!, /已清除/);
  ui.enabled.checked = false;
  ui.change(ui.enabled);
  await settle();
  assert.equal(ui.enabled.checked, true, "failed persistence restores the last known enabled state");
  assert.equal(ui.enabled.disabled, false);
  assert.doesNotMatch(ui.status.textContent!, /已停用/);
});

test("transport failure reports an error and permits a later cache-only retry", async (t) => {
  let fail = true;
  const ui = await mount(t, async () => {
    if (fail) throw new Error("浏览器存储连接暂时不可用。");
    return ok({ ...initial, entries: 0, bytes: 0, origins: [] });
  });
  await settle();
  assert.match(ui.status.textContent!, /暂时不可用/);
  assert.doesNotMatch(ui.status.textContent!, /已清除/);
  assert.equal(ui.clearAll.disabled, false);
  fail = false;
  ui.clearAll.click();
  await settle();
  assert.deepEqual(ui.messages, [{ type: "cache.status" }, { type: "cache.clear" }]);
  assert.match(ui.status.textContent!, /已清除全部缓存/);
});

test("cache initializer tolerates pages without its controls", async (t) => {
  const ui = await mount(t, async () => { throw new Error("must not send"); }, "<html><body></body></html>");
  assert.equal(ui.messages.length, 0);
});
