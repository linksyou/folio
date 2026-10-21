import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import test, { type TestContext } from "node:test";
import type { ExtensionRequest, PageCommand, PageProgress, PageState, Result } from "../src/shared/protocol.js";
import type { TimingEvent } from "../src/shared/diagnostics.js";
import { DEFAULT_TRANSLATION_STYLE, STYLE_STORAGE_KEY, translationStyleCss } from "../src/extension/translation-style.js";
import { DISPLAY_STORAGE_KEY } from "../src/extension/display-settings.js";
import { FLOATING_ENABLED_KEY, FLOATING_POSITION_KEY } from "../src/extension/floating-settings.js";

const bundle = build({ entryPoints: ["src/extension/content.ts"], bundle: true, write: false, platform: "browser", format: "iife" });

async function content(t: TestContext, options: {
  html?: string;
  appearance?: unknown;
  displayMode?: unknown;
  floatingEnabled?: boolean;
  getStorage?: () => Promise<Record<string, unknown>>;
  afterStorageSet?: (values: Record<string, unknown>) => Promise<void>;
  sendMessage?: (request: ExtensionRequest) => unknown;
} = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><main>${options.html ?? ""}</main></body></html>`, {
    runScripts: "outside-only", url: "https://article.test/first", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  let listener!: (message: PageCommand & { url?: string } | PageProgress | { type: "page.diagnostics" }, sender: { id: string }, reply: (result: unknown) => void) => void;
  let storageListener!: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;
  let appearance = options.appearance;
  let displayMode = options.displayMode;
  let floatingEnabled = options.floatingEnabled;
  const storageWrites: Record<string, unknown>[] = [];
  const requests: ExtensionRequest[] = [];
  const errors: unknown[] = [];
  dom.window.addEventListener("error", (event) => { errors.push(event.error); event.preventDefault(); });
  const removedListeners: string[] = [];
  const polls = new Map<number, () => void>();
  let sequence = 0;
  Object.defineProperty(dom.window, "structuredClone", { value: structuredClone });
  Object.defineProperty(dom.window, "setInterval", { value: (callback: () => void) => { polls.set(++sequence, callback); return sequence; } });
  Object.defineProperty(dom.window, "clearInterval", { value: (id: number) => { polls.delete(id); } });
  const runtime = {
      id: "content-test" as string | undefined,
      getURL: (file: string) => `chrome-extension://content-test/${file}`,
      onMessage: {
        addListener(value: typeof listener) { listener = value; },
        removeListener(value: typeof listener) { assert.equal(value, listener); removedListeners.push("message"); },
      },
      sendMessage: (request: ExtensionRequest) => {
        requests.push(request);
        if (options.sendMessage) return options.sendMessage(request);
        return Promise.resolve({ ok: true, result: request.type === "translate.batch"
          ? request.blocks.map((block) => ({ id: block.id, text: `译文：${block.text}` })) : [] });
      },
  };
  Object.defineProperty(dom.window, "chrome", { value: {
    runtime,
    storage: {
      local: {
        get: options.getStorage ?? (async () => ({ [STYLE_STORAGE_KEY]: appearance, [DISPLAY_STORAGE_KEY]: displayMode, [FLOATING_ENABLED_KEY]: floatingEnabled })),
        set: async (values: Record<string, unknown>) => {
          storageWrites.push(values);
          if (DISPLAY_STORAGE_KEY in values) displayMode = values[DISPLAY_STORAGE_KEY];
          storageListener(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), "local");
          await options.afterStorageSet?.(values);
        },
      },
      onChanged: {
        addListener(value: typeof storageListener) { storageListener = value; },
        removeListener(value: typeof storageListener) { assert.equal(value, storageListener); removedListeners.push("storage"); },
      },
    },
  } });
  const source = (await bundle).outputFiles[0]!.text;
  dom.window.eval(source);
  const command = (value: Omit<PageCommand, "type"> & { url?: string }): Result<PageState> => {
    let result!: Result<PageState>;
    listener({ type: "page.command", ...value }, { id: "content-test" }, (reply) => { result = reply as Result<PageState>; });
    return result;
  };
  return { dom, requests, polls, command, runtime, errors, removedListeners, storageWrites,
    changeFloating(enabled: boolean) {
      floatingEnabled = enabled;
      storageListener({ [FLOATING_ENABLED_KEY]: { newValue: enabled } }, "local");
    },
    changeFloatingPosition(value: unknown) {
      storageListener({ [FLOATING_POSITION_KEY]: { newValue: value } }, "local");
    },
    diagnostics() {
      let result!: TimingEvent[];
      listener({ type: "page.diagnostics" }, { id: "content-test" }, (reply) => { result = reply as TimingEvent[]; });
      return result;
    },
    changeAppearance(value: unknown, area = "local") {
      if (area === "local") appearance = value;
      storageListener({ [STYLE_STORAGE_KEY]: { newValue: value } }, area);
    },
    storeAppearance(value: unknown) { appearance = value; },
    changeDisplayMode(value: unknown, area = "local") {
      if (area === "local") displayMode = value;
      storageListener({ [DISPLAY_STORAGE_KEY]: { newValue: value } }, area);
    },
    storeDisplayMode(value: unknown) { displayMode = value; },
    progress(value: PageProgress) { listener(value, { id: "content-test" }, () => undefined); },
    reinstall() { dom.window.eval(source); }, transition(type: "pagehide" | "pageshow") {
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent(type, { persisted: true }));
  } };
}

test("content installs once and only a signed start enables SPA navigation requests", async (t) => {
  const harness = await content(t);
  harness.reinstall();
  assert.equal(harness.requests.filter((request) => request.type === "page.ready").length, 1);
  assert.equal(harness.polls.size, 1);
  harness.dom.window.history.pushState({}, "", "/second");
  harness.polls.values().next().value!();
  assert.equal(harness.requests.some((request) => request.type === "page.navigate"), false);
  assert.equal(harness.command({ action: "start", jobId: "job", settingsRevision: "revision", url: "https://article.test/second" }).ok, true);
  harness.dom.window.history.pushState({}, "", "/third");
  harness.polls.values().next().value!();
  const navigations = harness.requests.filter((request) => request.type === "page.navigate");
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].url, "https://article.test/third");
  assert.equal(navigations[0].navigationId, 1);
  harness.command({ action: "stop" });
  harness.dom.window.history.pushState({}, "", "/fourth");
  harness.polls.values().next().value!();
  assert.equal(harness.requests.filter((request) => request.type === "page.navigate").length, 1);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test("a validated clicked command records its page receipt before session extraction", async (t) => {
  const harness = await content(t, { html: "<p>Public timing fixture.</p>" });
  const clickedAtEpochMs = Date.now() - 75;
  harness.command({ action: "start", jobId: "timed-command", settingsRevision: "revision", clickedAtEpochMs });
  const trace = harness.diagnostics();
  const received = trace.find((event) => event.stage === "ui.commandReceived")!;
  const session = trace.find((event) => event.stage === "session.start")!;
  assert.equal(received.jobId, "timed-command");
  assert.ok(Number(received.values?.clickToCommandMs) >= 75);
  assert.ok(received.atMs <= session.atMs);
  assert.equal(harness.command({ action: "start", jobId: "wrong-page", settingsRevision: "revision", url: "https://article.test/another", clickedAtEpochMs }).ok, false);
  assert.equal(harness.diagnostics().filter((event) => event.stage === "ui.commandReceived").length, 1);
  harness.command({ action: "start", jobId: "automatic-command", settingsRevision: "revision" });
  assert.equal(harness.diagnostics().filter((event) => event.stage === "ui.commandReceived").length, 1, "automatic starts have no fabricated click");
  await settle();
});

test("stored appearance changes update existing translations without touching originals or translation jobs", async (t) => {
  const initial = { preset: "background", fontScale: 1.1 } as const;
  const harness = await content(t, { appearance: initial, html: '<p style="color: purple">Read this <a href="#source">original link</a>.</p>' });
  const document = harness.dom.window.document;
  const original = document.querySelector("p")!;
  const originalHtml = original.outerHTML;
  const link = original.querySelector("a")!;
  let clicked = 0;
  link.addEventListener("click", (event) => { event.preventDefault(); clicked += 1; });
  harness.command({ action: "start", jobId: "job-style", settingsRevision: "revision" });
  await settle();
  const output = document.querySelector('[data-open-web-translator="translation"]')!;
  assert.ok(output?.textContent?.includes("译文"));
  const translatedHtml = original.outerHTML;
  const css = () => document.querySelector("style[data-open-web-translator-style]")!.textContent;
  assert.equal(css(), translationStyleCss(initial));
  const beforeRequests = harness.requests.length;
  const beforeScans = harness.diagnostics().filter((event) => event.stage === "extraction.dynamic").length;
  const next = { preset: "underline", fontScale: 1.25 } as const;
  harness.changeAppearance(next);
  assert.equal(css(), translationStyleCss(next), "all existing wrappers adopt the new stylesheet immediately");
  await settle();
  assert.equal(document.querySelector('[data-open-web-translator="translation"]'), output);
  assert.equal(original.outerHTML, translatedHtml, "appearance updates do not change original or translated nodes");
  assert.equal(original.querySelector("a"), link);
  link.click();
  assert.equal(clicked, 1);
  assert.equal(harness.requests.length, beforeRequests, "appearance updates cannot retranslate or cancel");
  assert.equal(harness.diagnostics().filter((event) => event.stage === "extraction.dynamic").length, beforeScans, "our stylesheet cannot schedule source discovery");
  assert.equal(document.querySelectorAll("style[data-open-web-translator-style]").length, 1);
  harness.changeAppearance({ preset: "plain", fontScale: 0.9 }, "sync");
  assert.equal(css(), translationStyleCss(next), "other storage areas do not change local appearance");
  harness.changeAppearance(undefined);
  assert.equal(css(), translationStyleCss(DEFAULT_TRANSLATION_STYLE), "removing the setting restores its default");
  harness.command({ action: "restore" });
  assert.equal(document.querySelector('[data-open-web-translator="translation"]'), null);
  assert.equal(original.outerHTML, originalHtml);
});

test("a late storage read cannot overwrite a newer appearance change", async (t) => {
  let resolve!: (value: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>((done) => { resolve = done; });
  const harness = await content(t, { getStorage: () => pending });
  const next = { preset: "plain", fontScale: 0.9 } as const;
  harness.changeAppearance(next);
  resolve({ [STYLE_STORAGE_KEY]: { preset: "background", fontScale: 1.25 } });
  await settle();
  assert.equal(harness.dom.window.document.querySelector("style[data-open-web-translator-style]")!.textContent, translationStyleCss(next));
});

test("storage errors retain the default stylesheet and leave translation usable", async (t) => {
  const harness = await content(t, { html: "<p>A paragraph to translate.</p>", getStorage: async () => { throw new Error("offline"); } });
  harness.command({ action: "start", jobId: "job-style-offline", settingsRevision: "revision" });
  await settle();
  assert.equal(harness.dom.window.document.querySelector("style[data-open-web-translator-style]")!.textContent, translationStyleCss(DEFAULT_TRANSLATION_STYLE));
  assert.ok(harness.dom.window.document.querySelector('[data-open-web-translator="translation"]'));
});

test("BFcache restoration reloads appearance without restarting an explicitly stopped page", async (t) => {
  const harness = await content(t);
  harness.command({ action: "stop" });
  const requests = harness.requests.length;
  harness.transition("pagehide");
  const next = { preset: "background", fontScale: 1.25 } as const;
  harness.storeAppearance(next); // BFcache documents may miss onChanged events.
  harness.transition("pageshow");
  await settle();
  assert.equal(harness.dom.window.document.querySelector("style[data-open-web-translator-style]")!.textContent, translationStyleCss(next));
  assert.equal(harness.requests.length, requests);
  const status = harness.command({ action: "status" });
  assert.equal(status.ok && status.result.status, "stopped");
});

test("head replacement restores exactly one stylesheet with the selected appearance", async (t) => {
  const next = { preset: "underline", fontScale: 1.1 } as const;
  const harness = await content(t, { appearance: next });
  await settle();
  const document = harness.dom.window.document;
  document.head.replaceWith(document.createElement("head"));
  await settle();
  assert.equal(document.querySelectorAll("style[data-open-web-translator-style]").length, 1);
  assert.equal(document.querySelector("style[data-open-web-translator-style]")!.textContent, translationStyleCss(next));
});

test("stale page commands are rejected before they can enable continuation", async (t) => {
  const harness = await content(t);
  const response = harness.command({ action: "start", jobId: "job", settingsRevision: "revision", url: "https://article.test/old" });
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, "CANCELLED");
  harness.dom.window.history.pushState({}, "", "/next");
  harness.polls.values().next().value!();
  assert.equal(harness.requests.some((request) => request.type === "page.navigate"), false);
});

test("restored BFcache documents keep explicit stop/restore intent and restart only their URL observer", async (t) => {
  for (const action of ["stop", "restore"] as const) {
    await t.test(action, async (t) => {
      const harness = await content(t);
      harness.command({ action });
      harness.transition("pagehide");
      assert.equal(harness.polls.size, 0);
      harness.transition("pageshow");
      assert.equal(harness.polls.size, 1);
      assert.equal(harness.requests.filter((request) => request.type === "page.ready").length, 1, "must not send ready even if another document replaced the tab's background intent");
      const status = harness.command({ action: "status" });
      assert.equal(status.ok, true);
      if (status.ok) assert.equal(status.result.status, action === "restore" ? "idle" : "stopped");
      harness.dom.window.history.pushState({}, "", "/after-back");
      harness.polls.values().next().value!();
      assert.equal(harness.requests.some((request) => request.type === "page.navigate"), false);
    });
  }
});

test("an explicitly resumed document can handshake again after BFcache restoration", async (t) => {
  const harness = await content(t);
  harness.command({ action: "stop" });
  harness.command({ action: "start", jobId: "job", settingsRevision: "revision" });
  harness.transition("pagehide");
  harness.transition("pageshow");
  const ready = harness.requests.filter((request) => request.type === "page.ready");
  assert.equal(ready.length, 2);
  assert.equal(ready[1].restored, true);
  assert.equal(harness.polls.size, 1);
});

test("a synchronous invalid-context error during SPA navigation retires the old script", async (t) => {
  const harness = await content(t, { sendMessage(request) {
    if (request.type === "page.navigate") throw new Error("Extension context invalidated.");
    return Promise.resolve({ ok: true, result: [] });
  } });
  harness.command({ action: "start", jobId: "old-context", settingsRevision: "revision" });
  const oldPoll = harness.polls.values().next().value!;
  harness.dom.window.history.pushState({}, "", "/new-route");
  assert.doesNotThrow(oldPoll);
  await settle();
  assert.equal(harness.requests.filter(({ type }) => type === "page.navigate").length, 1);
  assert.equal(harness.polls.size, 0);
  assert.deepEqual(harness.removedListeners.sort(), ["message", "storage"]);
  const calls = harness.requests.length;
  oldPoll();
  harness.dom.window.dispatchEvent(new harness.dom.window.PopStateEvent("popstate"));
  harness.transition("pagehide");
  harness.transition("pageshow");
  harness.command({ action: "start", jobId: "late-command", settingsRevision: "revision" });
  await settle();
  assert.equal(harness.polls.size, 0, "BFCache cannot restart a retired extension context");
  assert.equal(harness.requests.length, calls);
  assert.deepEqual(harness.errors, []);
});

test("lost runtime identity stops idle polling and observers while preserving completed translations", async (t) => {
  for (const failure of ["missing", "throwing getter"] as const) {
    await t.test(failure, async (t) => {
      const harness = await content(t, { html: "<p>Keep the completed translation.</p>" });
      harness.command({ action: "start", jobId: "completed-context", settingsRevision: "revision" });
      await settle();
      const document = harness.dom.window.document;
      const output = document.querySelector('[data-open-web-translator="translation"]')!;
      assert.ok(output);
      const calls = harness.requests.length;
      if (failure === "missing") harness.runtime.id = undefined;
      else Object.defineProperty(harness.runtime, "id", { get() { throw new Error("Extension context invalidated."); } });
      assert.doesNotThrow(harness.polls.values().next().value!);
      assert.equal(harness.polls.size, 0, "retire even when the URL has not changed");
      assert.equal(harness.requests.length, calls, "cleanup must not call an invalid Chrome runtime");
      document.querySelector("p")!.firstChild!.textContent = "The host changed the source after retirement.";
      document.querySelector("main")!.insertAdjacentHTML("beforeend", "<p>Do not translate newly inserted content.</p>");
      document.head.replaceWith(document.createElement("head"));
      harness.changeAppearance({ preset: "underline", fontScale: 1.1 });
      document.dispatchEvent(new harness.dom.window.Event("scroll"));
      document.dispatchEvent(new harness.dom.window.Event("visibilitychange"));
      harness.transition("pageshow");
      await settle();
      assert.equal(output.isConnected, true, "the retired translator no longer edits existing outputs");
      assert.equal(document.querySelectorAll('[data-open-web-translator="translation"]').length, 1);
      assert.equal(document.querySelector("style[data-open-web-translator-style]"), null, "appearance observer is detached too");
      assert.equal(harness.requests.length, calls);
      assert.deepEqual(harness.errors, []);
    });
  }
});

test("initial ready handles both thrown and rejected invalid-context errors", async (t) => {
  for (const failure of ["throw", "reject"] as const) {
    await t.test(failure, async (t) => {
      const harness = await content(t, { sendMessage() {
        const error = new Error("Extension context invalidated.");
        if (failure === "throw") throw error;
        return Promise.reject(error);
      } });
      await settle();
      assert.equal(harness.requests.length, 1);
      assert.equal(harness.polls.size, 0);
      harness.transition("pageshow");
      assert.equal(harness.polls.size, 0);
      assert.deepEqual(harness.errors, []);
    });
  }
});

test("context loss in an abort callback cannot throw or let a late translation write back", async (t) => {
  let finish!: (response: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  const harness = await content(t, { html: "<p>A pending translation.</p>", sendMessage(request) {
    if (request.type === "translate.batch") return pending;
    if (request.type === "translate.cancelBatch") throw new Error("Extension context invalidated.");
    return Promise.resolve({ ok: true, result: [] });
  } });
  harness.command({ action: "start", jobId: "pending-context", settingsRevision: "revision" });
  const batch = harness.requests.find((request) => request.type === "translate.batch")!;
  assert.ok(batch);
  harness.transition("pagehide");
  assert.equal(harness.polls.size, 0);
  const calls = harness.requests.length;
  finish({ ok: true, result: batch.blocks.map(({ id }) => ({ id, text: "过期译文" })) });
  harness.transition("pageshow");
  await settle();
  assert.equal(harness.requests.length, calls, "retirement cannot recursively send cancellation");
  assert.equal(harness.dom.window.document.querySelector('[data-open-web-translator="translation"]'), null);
  assert.deepEqual(harness.errors, []);
});

test("an invalid-context storage error retires the script instead of reviving appearance later", async (t) => {
  const harness = await content(t, { getStorage: async () => { throw new Error("Extension context invalidated."); } });
  await settle();
  assert.equal(harness.polls.size, 0);
  const calls = harness.requests.length;
  harness.transition("pageshow");
  await settle();
  assert.equal(harness.polls.size, 0);
  assert.equal(harness.requests.length, calls);
  assert.deepEqual(harness.errors, []);
});

test("a transient messaging failure does not retire a healthy extension context", async (t) => {
  let failed = false;
  const harness = await content(t, { sendMessage(request) {
    if (request.type === "page.navigate" && !failed) {
      failed = true;
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
    return Promise.resolve({ ok: true, result: [] });
  } });
  harness.command({ action: "start", jobId: "healthy-context", settingsRevision: "revision" });
  for (const url of ["/second", "/third"]) {
    harness.dom.window.history.pushState({}, "", url);
    assert.doesNotThrow(harness.polls.values().next().value!);
    await settle();
  }
  assert.equal(harness.requests.filter(({ type }) => type === "page.navigate").length, 2);
  assert.equal(harness.polls.size, 1);
  assert.deepEqual(harness.removedListeners, []);
  assert.deepEqual(harness.errors, []);
});

test("local display mode updates existing translations without requests and keeps interactive ranges safe", async (t) => {
  const harness = await content(t, { html: '<p id="plain">A plain paragraph.</p><p id="linked">Read the <a href="#source">original link</a>.</p>', displayMode: "bilingual" });
  await settle();
  harness.command({ action: "start", jobId: "display-update", settingsRevision: "revision", displayMode: "translation-only" });
  await settle();
  const document = harness.dom.window.document;
  const plain = document.querySelector("#plain")!;
  const source = [...plain.childNodes].find((node) => node.nodeType === 3)!;
  const output = plain.querySelector('[data-open-web-translator="translation"]')!;
  assert.equal(source.textContent, "A plain paragraph.", "stored bilingual preference beats a legacy command");
  const requests = harness.requests.length;
  harness.changeDisplayMode("translation-only");
  assert.equal(source.textContent, "");
  assert.ok(output.isConnected);
  assert.equal(document.querySelector("#linked a")!.textContent, "original link", "interactive source remains available");
  harness.changeDisplayMode("bilingual", "sync");
  assert.equal(source.textContent, "", "only local storage controls display");
  harness.changeDisplayMode("bilingual");
  assert.equal(source.textContent, "A plain paragraph.");
  await settle();
  assert.equal(harness.requests.length, requests, "display changes cannot generate or cancel model work");
  harness.command({ action: "restore" });
  assert.equal(source.textContent, "A plain paragraph.");
  assert.equal(document.querySelector('[data-open-web-translator="translation"]'), null);
});

test("a late display read cannot replace a newer selection or cancel an in-flight preview", async (t) => {
  let finishRead!: (value: Record<string, unknown>) => void;
  const read = new Promise<Record<string, unknown>>((resolve) => { finishRead = resolve; });
  let finishTranslation!: (value: unknown) => void;
  const result = new Promise((resolve) => { finishTranslation = resolve; });
  const harness = await content(t, { html: '<p id="plain">A streaming paragraph.</p>', getStorage: () => read,
    sendMessage: (request) => request.type === "translate.batch" ? result : Promise.resolve({ ok: true, result: {} }),
  });
  harness.command({ action: "start", jobId: "display-stream", settingsRevision: "revision", displayMode: "bilingual" });
  await settle();
  const batch = harness.requests.find((request) => request.type === "translate.batch");
  assert.ok(batch?.type === "translate.batch");
  harness.progress({ type: "translate.progress", jobId: batch.jobId, batchId: batch.batchId!, translations: batch.blocks.map(({ id }) => ({ id, text: "正在" })) });
  const output = harness.dom.window.document.querySelector('[data-open-web-translator="translation"]')!;
  assert.equal(output.textContent, "正在");
  const requests = harness.requests.length;
  harness.changeDisplayMode("translation-only");
  finishRead({ [DISPLAY_STORAGE_KEY]: "bilingual" });
  await settle();
  assert.equal(harness.requests.length, requests);
  assert.equal(output.textContent, "正在", "changing display leaves the active stream intact");
  finishTranslation({ ok: true, result: batch.blocks.map(({ id }) => ({ id, text: "完成译文" })) });
  await settle();
  const paragraph = harness.dom.window.document.querySelector("#plain")!;
  assert.equal(paragraph.firstChild!.textContent, "", "the final result uses the newer local preference");
  assert.equal(output.textContent, "完成译文");
  harness.command({ action: "stop" });
  harness.transition("pagehide");
  harness.storeDisplayMode("bilingual");
  const stoppedRequests = harness.requests.length;
  harness.transition("pageshow");
  await settle();
  assert.equal(paragraph.firstChild!.textContent, "A streaming paragraph.", "BFcache reloads display without resuming a stopped job");
  assert.equal(harness.requests.length, stoppedRequests);
});

test("BFcache restoration notices a removed local display preference without resuming translation", async (t) => {
  const harness = await content(t, { html: '<p id="plain">A previously hidden paragraph.</p>', displayMode: "translation-only" });
  await settle();
  harness.command({ action: "start", jobId: "removed-display", settingsRevision: "revision" });
  await settle();
  const source = [...harness.dom.window.document.querySelector("#plain")!.childNodes].find((node) => node.nodeType === 3)!;
  assert.equal(source.textContent, "");
  harness.command({ action: "stop" });
  harness.transition("pagehide");
  harness.storeDisplayMode(undefined);
  const requests = harness.requests.length;
  harness.transition("pageshow");
  await settle();
  assert.equal(source.textContent, "A previously hidden paragraph.");
  assert.equal(harness.requests.length, requests);
});

test("floating preference updates live without extra polling, translation or source discovery", async (t) => {
  const harness = await content(t, { floatingEnabled: false, html: "<p>A public paragraph for floating controls.</p>" });
  await settle();
  const host = () => harness.dom.window.document.querySelector<HTMLElement>("[data-open-web-translator-ui]");
  harness.command({ action: "start", jobId: "floating-read", settingsRevision: "revision" });
  await settle();
  const requests = harness.requests.length;
  const scans = harness.diagnostics().filter((event) => event.stage === "extraction.dynamic").length;
  harness.changeFloating(true);
  await settle();
  assert.ok(host()?.isConnected);
  assert.equal(host()!.hidden, false);
  assert.equal(harness.polls.size, 1, "only the existing URL poll remains");
  assert.equal(harness.requests.length, requests);
  assert.equal(harness.diagnostics().filter((event) => event.stage === "extraction.dynamic").length, scans);
  harness.command({ action: "restore" });
  assert.ok(host()?.isConnected, "restoring original text must not remove floating controls");
  harness.dom.window.document.body.replaceWith(harness.dom.window.document.createElement("body"));
  assert.ok(host()?.isConnected, "the widget survives a replaced body");
  harness.changeFloating(false);
  assert.equal(host()?.hidden, true);
  harness.runtime.id = undefined;
  harness.polls.values().next().value!();
  assert.equal(host(), null, "invalidated extension contexts remove the widget");
});

test("a floating position update does not discard the initial enable preference", async (t) => {
  let finishRead!: (value: Record<string, unknown>) => void;
  const read = new Promise<Record<string, unknown>>((resolve) => { finishRead = resolve; });
  const harness = await content(t, { getStorage: () => read });
  const host = harness.dom.window.document.querySelector<HTMLElement>("[data-open-web-translator-ui]")!;
  assert.equal(host.hidden, true, "wait for the saved enable preference before showing");
  harness.changeFloatingPosition({ edge: "left", ratio: 0 });
  finishRead({ [FLOATING_ENABLED_KEY]: true, [FLOATING_POSITION_KEY]: { edge: "right", ratio: 1 } });
  await settle();
  assert.equal(host.hidden, false, "the independent enabled read still applies");
  assert.equal(host.dataset.edge, "left", "the newer position wins over the initial read");
  assert.equal(host.style.top, "14px");
});

test("a floating enable update does not discard the independently saved position", async (t) => {
  let finishRead!: (value: Record<string, unknown>) => void;
  const read = new Promise<Record<string, unknown>>((resolve) => { finishRead = resolve; });
  const harness = await content(t, { getStorage: () => read });
  const host = harness.dom.window.document.querySelector<HTMLElement>("[data-open-web-translator-ui]")!;
  harness.changeFloating(false);
  finishRead({ [FLOATING_ENABLED_KEY]: true, [FLOATING_POSITION_KEY]: { edge: "left", ratio: 0 } });
  await settle();
  assert.equal(host.hidden, true, "the newer disabled preference wins over the initial read");
  assert.equal(host.dataset.edge, "left", "the independent position read still applies");
  assert.equal(host.style.top, "14px");
  harness.changeFloating(true);
  assert.equal(host.hidden, false);
  assert.equal(host.dataset.edge, "left");
});

