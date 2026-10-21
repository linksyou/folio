import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import type { Result, TextBlock, Translation } from "../src/shared/protocol.js";
import {
  PageTranslator,
  type TranslationOptions,
  type TranslationTransport,
} from "../src/extension/page/PageTranslator.js";

const fixturePath = fileURLToPath(new URL("./fixtures/article.html", import.meta.url));

function pageDom(html: string, options?: ConstructorParameters<typeof JSDOM>[1]): JSDOM {
  return new JSDOM(html, { pretendToBeVisual: true, ...options });
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settleViewport = () => new Promise<void>((resolve) => setTimeout(resolve, 65));

function changeVisibility(dom: JSDOM, state: DocumentVisibilityState): void {
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: state });
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
}

class FakeTransport implements TranslationTransport {
  calls: Array<{ jobId: string; blocks: TextBlock[]; options?: TranslationOptions }> = [];
  cancelled: string[] = [];
  responder: (blocks: TextBlock[], options?: TranslationOptions) => Promise<Result<Translation[]>> = async (blocks) => ({
    ok: true,
    result: blocks.map((block) => ({ id: block.id, text: `译文：${block.text}` })),
  });

  async translate(jobId: string, _settingsRevision: string, blocks: TextBlock[], options?: TranslationOptions) {
    this.calls.push({ jobId, blocks, options });
    return this.responder(blocks, options);
  }

  async cancel(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
  }
}

test("target-language content stays original, settles reading counts and force explicitly translates it", async () => {
  const chinese = "这是一段中文内容，我们可以在这里阅读文章。";
  const dom = pageDom(`<html lang="zh-CN"><main><p>${chinese}</p></main></html>`);
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.setDisplayMode("translation-only");
  translator.handle("start", "language", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 0);
  assert.equal(translator.getState().skipped, 1);
  assert.equal(translator.getState().completed, 0);
  assert.equal(translator.getState().status, "completed");
  assert.match(translator.getState().message, /已是目标语言/);
  assert.equal(dom.window.document.querySelector("p")!.textContent, chinese);
  assert.equal(translator.getDiagnostics().find((event) => event.stage === "reading.completed")?.values?.skipped, 1);
  assert(!translator.getDiagnostics().some((event) => event.stage === "reading.firstVisible"));
  translator.handle("retranslate", "forced-language", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 1);
  assert.equal(translator.getState().skipped, 0);
  assert.equal(translator.getState().completed, 1);
  translator.handle("restore");
  assert.equal(dom.window.document.querySelector("p")!.textContent, chinese);
  dom.window.close();
});

test("mixed content ignores misleading page language and dynamic edits recheck the source", async () => {
  const chinese = "这是一段中文内容，我们可以在这里阅读文章。";
  const dom = pageDom(`<html lang="zh-CN"><main><p id="chinese">${chinese}</p><p id="english">This English paragraph must still be translated.</p></main></html>`);
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "mixed", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.flatMap((call) => call.blocks).length, 1);
  assert.equal(translator.getState().skipped, 1);
  dom.window.document.querySelector("#chinese")!.textContent = "This new English text needs a translation after editing.";
  await settleViewport();
  await translator.whenIdle();
  assert.equal(transport.calls.flatMap((call) => call.blocks).length, 2);
  assert.equal(translator.getState().skipped, 0);
  dom.window.document.querySelector("#english")!.textContent = chinese;
  await settleViewport();
  await translator.whenIdle();
  assert.equal(translator.getState().skipped, 1);
  assert.equal(dom.window.document.querySelector("#english [data-open-web-translator]"), null);
  assert.equal(transport.calls.length, 2);
  translator.handle("stop");
  dom.window.document.querySelector("#english")!.textContent = "Stopped pages must not start translating a changed source.";
  await settleViewport();
  assert.equal(transport.calls.length, 2);
  dom.window.close();
});

test("changing target language reevaluates skipped ranges and does not hide a needed translation", async () => {
  const dom = pageDom("<main><p>这是一段中文内容，我们可以在这里阅读文章。</p></main>");
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "chinese", "zh-settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 0);
  translator.setTargetLanguage("en");
  translator.handle("start", "english", "en-settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 1);
  assert.equal(translator.getState().skipped, 0);
  assert.equal(translator.getState().completed, 1);
  dom.window.close();
});

test("changing an inherited language hint reevaluates unchanged original text", async () => {
  const dom = pageDom('<html lang="en"><main><p>This is the article that we can read with our friends and our family.</p></main></html>');
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.setTargetLanguage("en");
  translator.handle("start", "lang-hint", "settings");
  await translator.whenIdle();
  assert.equal(translator.getState().skipped, 1);
  dom.window.document.documentElement.lang = "de";
  await settleViewport();
  await translator.whenIdle();
  assert.equal(transport.calls.length, 1);
  assert.equal(translator.getState().skipped, 0);
  dom.window.document.documentElement.lang = "en";
  await settleViewport();
  await translator.whenIdle();
  assert.equal(translator.getState().skipped, 1);
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
  dom.window.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("extracts leaf content without changing links, code, or hidden regions", async () => {
  const html = await readFile(fixturePath, "utf8");
  const dom = pageDom(html, { url: "https://example.com/article" });
  const transport = new FakeTransport();
  const link = dom.window.document.querySelector("a");
  const code = dom.window.document.getElementById("code-block")?.textContent;
  const translator = new PageTranslator(dom.window.document, transport);

  const immediate = translator.handle("start", "job-1", "settings-1");
  assert.equal(immediate.status, "running");
  await translator.whenIdle();

  const state = translator.getState();
  assert.equal(state.status, "completed");
  assert.equal(state.total, 3);
  assert.equal(dom.window.document.querySelector("a"), link);
  assert.equal(dom.window.document.getElementById("code-block")?.textContent, code);
  assert.equal(dom.window.document.querySelector("#hidden + [data-open-web-translator]"), null);
  assert.equal(dom.window.document.querySelector("header [data-open-web-translator]"), null);
  assert.equal(dom.window.document.querySelectorAll("[data-open-web-translator]").length, 3);
});

test("restore prevents a late batch from returning to the page", async () => {
  const dom = pageDom("<main><p>One paragraph to translate.</p></main>", {
    url: "https://example.com/late",
  });
  const pending = deferred<Result<Translation[]>>();
  const transport = new FakeTransport();
  transport.responder = () => pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);

  translator.handle("start", "job-late", "settings-1");
  const restored = translator.handle("restore");
  assert.equal(restored.status, "idle");
  pending.resolve({ ok: true, result: [{ id: "block-1.1", text: "迟到译文" }] });
  await translator.whenIdle();

  assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
  assert.deepEqual(transport.cancelled, ["job-late"]);
});

test("a malformed batch fails as a unit and retry sends only failed paragraphs", async () => {
  const paragraphs = Array.from({ length: 6 }, (_, index) => `<p>Paragraph ${index + 1}.</p>`).join("");
  const dom = pageDom(`<main>${paragraphs}</main>`, { url: "https://example.com/retry" });
  // Prefetch keeps two-paragraph batching; visible short paragraphs batch up to three.
  for (const paragraph of dom.window.document.querySelectorAll("p")) {
    paragraph.getBoundingClientRect = () => ({ top: 1_000, bottom: 1_080 } as DOMRect);
  }
  const transport = new FakeTransport();
  transport.responder = async (blocks) => {
    if (blocks.some((block) => block.id === "block-1.1")) {
      return { ok: true, result: blocks.slice(1).map((block) => ({ id: block.id, text: "partial" })) };
    }
    return { ok: true, result: blocks.map((block) => ({ id: block.id, text: `译文 ${block.id}` })) };
  };
  const translator = new PageTranslator(dom.window.document, transport);

  translator.handle("start", "job-first", "settings-1");
  await translator.whenIdle();
  assert.deepEqual(translator.getState(), {
    status: "completed",
    total: 6,
    completed: 4,
    skipped: 0,
    failed: 2,
    message: "翻译完成，部分段落可重试。",
  });

  transport.responder = async (blocks) => ({
    ok: true,
    result: blocks.map((block) => ({ id: block.id, text: `重试 ${block.id}` })),
  });
  translator.handle("retry", "job-retry", "settings-1");
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 6);
  assert.equal(translator.getState().failed, 0);
  const retryIds = transport.calls
    .filter((call) => call.jobId === "job-retry")
    .flatMap((call) => call.blocks.map((block) => block.id));
  assert.deepEqual(retryIds, ["block-1.1", "block-2.1"]);
});

test("restored translations are reused once without duplicate injection", async () => {
  const dom = pageDom("<article><p>Cached paragraph.</p></article>", {
    url: "https://example.com/cache",
  });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);

  translator.handle("start", "job-cache-1", "settings-1");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 1);
  translator.handle("restore");
  assert.equal(dom.window.document.querySelectorAll("[data-open-web-translator]").length, 0);

  const state = translator.handle("start", "job-cache-2", "settings-1");
  await translator.whenIdle();
  assert.equal(state.status, "completed");
  assert.equal(transport.calls.length, 1);
  assert.equal(dom.window.document.querySelectorAll("[data-open-web-translator]").length, 1);
});

test("a rejected host request pauses the queue instead of leaving the page running", async () => {
  const paragraphs = Array.from({ length: 6 }, (_, index) => `<p>Paragraph ${index + 1}.</p>`).join("");
  const dom = pageDom(`<main>${paragraphs}</main>`, { url: "https://example.com/disconnect" });
  const transport = new FakeTransport();
  transport.responder = async () => { throw new Error("native port closed"); };
  const translator = new PageTranslator(dom.window.document, transport);

  translator.handle("start", "job-disconnected", "settings-1");
  await translator.whenIdle();

  const state = translator.getState();
  assert.equal(state.status, "paused");
  assert.equal(state.failed, 6);
  assert.match(state.message, /连接中断/);
  assert.deepEqual(transport.cancelled, ["job-disconnected"]);
});

test("skips content hidden by an ancestor and keeps list translations inside list items", async () => {
  const dom = pageDom(`
    <main>
      <section style="display:none"><p>Hidden through parent.</p></section>
      <ul><li>Visible list item with <code>inline()</code>.</li></ul>
    </main>
  `, { url: "https://example.com/visibility" });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);

  translator.handle("start", "job-visible", "settings-1");
  await translator.whenIdle();

  assert.equal(translator.getState().total, 1);
  assert.equal(transport.calls.flatMap((call) => call.blocks).some((block) => block.text.includes("Hidden")), false);
  assert.equal(dom.window.document.querySelectorAll("ul > [data-open-web-translator]").length, 0);
  assert.equal(dom.window.document.querySelectorAll("ul > li > [data-open-web-translator]").length, 1);
  assert.match(dom.window.document.querySelector("li")?.textContent ?? "", /inline\(\)/);
});

test("extracts only visible paragraph descendants while preserving link and inline code text", async () => {
  const dom = pageDom(`
    <main><p id="source">
      Visible <a href="/source">linked text</a> and <code>inline()</code>.
      <span hidden>HIDDEN_ATTRIBUTE</span>
      <span aria-hidden="true">ARIA_HIDDEN</span>
      <span style="display:none">DISPLAY_NONE</span>
      <span style="visibility:hidden">VISIBILITY_HIDDEN</span>
      <script>const SECRET_SCRIPT = true;</script>
      <style>.secret-style { display: block }</style>
      <form><input value="SECRET_INPUT"><button>SECRET_BUTTON</button></form>
      <span contenteditable="true">SECRET_EDITOR</span>
    </p></main>
  `, { url: "https://example.com/visible-descendants" });
  const transport = new FakeTransport();
  const link = dom.window.document.querySelector("a");
  const inlineCode = dom.window.document.querySelector("code");
  const translator = new PageTranslator(dom.window.document, transport);

  translator.handle("start", "job-descendants", "settings-1");
  await translator.whenIdle();

  const sent = transport.calls.flatMap((call) => call.blocks).map((block) => block.text).join(" ");
  assert.match(sent, /Visible linked text and inline\(\)\./);
  for (const secret of [
    "HIDDEN_ATTRIBUTE",
    "ARIA_HIDDEN",
    "DISPLAY_NONE",
    "VISIBILITY_HIDDEN",
    "SECRET_SCRIPT",
    "secret-style",
    "SECRET_INPUT",
    "SECRET_BUTTON",
    "SECRET_EDITOR",
  ]) {
    assert.doesNotMatch(sent, new RegExp(secret));
  }
  assert.equal(dom.window.document.querySelector("a"), link);
  assert.equal(dom.window.document.querySelector("code"), inlineCode);
});

test("never sends a split chunk beyond the host character limit", async () => {
  const source = `${"a".repeat(3_999)}. ${"b".repeat(4_001)}`;
  const dom = pageDom(`<main><p>${source}</p></main>`, { url: "https://example.com/long" });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);

  translator.handle("start", "job-long", "settings-1");
  await translator.whenIdle();

  const chunks = transport.calls.flatMap((call) => call.blocks);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 4_000));
});

test("requeues changed source and drops its previous version result", async () => {
  const dom = pageDom("<main><p id='source'>Original text.</p></main>", {
    url: "https://example.com/edit",
  });
  const pending = deferred<Result<Translation[]>>();
  const transport = new FakeTransport();
  transport.responder = (blocks) => blocks[0].text === "Original text." ? pending.promise
    : Promise.resolve({ ok: true, result: blocks.map(({ id }) => ({ id, text: "当前译文" })) });
  const translator = new PageTranslator(dom.window.document, transport);

  translator.handle("start", "job-edit", "settings-1");
  dom.window.document.getElementById("source")!.textContent = "Changed text.";
  pending.resolve({ ok: true, result: [{ id: "block-1.1", text: "不应出现" }] });
  await translator.whenIdle();

  assert.equal(dom.window.document.querySelector("[data-open-web-translator]")?.textContent, "当前译文");
  assert.equal(translator.getState().failed, 0);
  assert.notEqual(transport.calls[1].blocks[0].id, transport.calls[0].blocks[0].id);
  assert.equal(transport.calls[1].blocks[0].text, "Changed text.");
});

test("URL changes clear the old page once and retry starts a fresh translation", async () => {
  const dom = pageDom("<main><p>Page text.</p></main>", { url: "https://example.com/one" });
  const transport = new FakeTransport();
  let url = "https://example.com/one";
  const translator = new PageTranslator(dom.window.document, transport, { getUrl: () => url });

  translator.handle("start", "job-one", "settings-1");
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 1);

  url = "https://example.com/two";
  const changed = translator.getState();
  assert.equal(changed.status, "stopped");
  assert.deepEqual({ total: changed.total, completed: changed.completed, failed: changed.failed }, {
    total: 0,
    completed: 0,
    failed: 0,
  });
  const cancelCount = transport.cancelled.length;
  translator.getState();
  assert.equal(transport.cancelled.length, cancelCount);

  const restarted = translator.handle("retry", "job-two", "settings-1");
  assert.equal(restarted.status, "running");
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 1);
  assert.ok(transport.calls.some((call) => call.jobId === "job-two"));
});

function viewportFixture(count: number, spacing = 1_000) {
  const paragraphs = Array.from({ length: count }, (_, i) => `<p>Paragraph ${i + 1}.</p>`).join("");
  const dom = pageDom(`<main>${paragraphs}</main>`, { url: "https://example.com/viewport" });
  Object.defineProperty(dom.window, "innerHeight", { value: 800 });
  let offset = 0;
  for (const [index, element] of [...dom.window.document.querySelectorAll("p")].entries()) {
    element.getBoundingClientRect = () => ({
      top: index * spacing + 20 - offset, bottom: index * spacing + 100 - offset,
      left: 0, right: 600, width: 600, height: 80, x: 0, y: index * spacing + 20 - offset,
      toJSON() {},
    });
  }
  return { dom, scroll(to: number) { offset = to; dom.window.document.dispatchEvent(new dom.window.Event("scroll")); } };
}

test("translates the visible window first and finishes the remaining page without scrolling", async () => {
  const { dom, scroll } = viewportFixture(5);
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  scroll(1_000);
  translator.handle("start", "window", "settings");
  await translator.whenIdle();
  const requested = transport.calls.flatMap((call) => call.blocks.map((block) => block.text));
  assert.deepEqual(requested.slice(0, 2), ["Paragraph 2.", "Paragraph 3."]);
  assert.deepEqual([...requested].sort(), Array.from({ length: 5 }, (_, index) => `Paragraph ${index + 1}.`));
  assert.equal(translator.getState().failed, 0);
  assert.equal(translator.getState().completed, 5);
  assert.equal(translator.getState().status, "completed");
  const calls = transport.calls.length;
  scroll(3_000);
  await translator.whenIdle();
  assert.equal(transport.calls.length, calls, "scrolling into the completed page does not repeat requests");
});

test("quick scrolling reprioritizes undispatched batches and keeps at most two requests active", async () => {
  const { dom, scroll } = viewportFixture(18, 200);
  const transport = new FakeTransport();
  const gates = [deferred<void>(), deferred<void>()];
  let active = 0;
  let peak = 0;
  let callIndex = 0;
  transport.responder = async (blocks) => {
    active++;
    peak = Math.max(peak, active);
    const gate = gates[callIndex++];
    if (gate) await gate.promise;
    active--;
    return { ok: true, result: blocks.map(({ id }) => ({ id, text: `译文 ${id}` })) };
  };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "scroll", "settings");
  assert.equal(transport.calls.length, 2);
  scroll(2_000);
  gates.forEach((gate) => gate.resolve());
  await translator.whenIdle();
  assert.equal(peak, 2);
  assert.equal(transport.calls[2].blocks[0].text, "Paragraph 11.");
  assert.ok(transport.calls.findIndex((call) => call.blocks.some((block) => block.text === "Paragraph 5.")) > 2,
    "old offscreen work resumes only after the new reading window gets priority");
});

test("a completed small batch appears while another batch is still pending", async () => {
  const { dom } = viewportFixture(4, 100);
  const transport = new FakeTransport();
  const pending = deferred<void>();
  transport.responder = async (blocks) => {
    if (blocks[0].id === "block-4.1") await pending.promise;
    return { ok: true, result: blocks.map(({ id }) => ({ id, text: `译文 ${id}` })) };
  };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "progressive", "settings");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(translator.getState().status, "running");
  assert.equal(dom.window.document.querySelectorAll("[data-open-web-translator]").length, 3);
  pending.resolve();
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 4);
});

test("stop and restore disable scroll-triggered work", async () => {
  for (const action of ["stop", "restore"] as const) {
    const { dom, scroll } = viewportFixture(5);
    const transport = new FakeTransport();
    const translator = new PageTranslator(dom.window.document, transport);
    translator.handle("start", `before-${action}`, "settings");
    await translator.whenIdle();
    assert.equal(translator.getState().status, "completed");
    const calls = transport.calls.length;
    scroll(3_000); // Also exercise a scroll already queued when the action arrives.
    translator.handle(action);
    scroll(4_000);
    await translator.whenIdle();
    assert.equal(transport.calls.length, calls);
    assert.equal(translator.getState().status, action === "stop" ? "stopped" : "idle");
  }
});

test("remaining-page fill starts only after reading requests settle and uses one request slot", async () => {
  const { dom } = viewportFixture(6);
  const transport = new FakeTransport();
  const gates = Array.from({ length: 3 }, () => deferred<Result<Translation[]>>());
  transport.responder = async (blocks) => gates[transport.calls.length - 1]?.promise
    ?? { ok: true, result: blocks.map(({ id }) => ({ id, text: "后续正文" })) };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "background-fill", "settings");
  assert.equal(transport.calls.length, 2);
  const finish = (index: number) => gates[index].resolve({ ok: true,
    result: transport.calls[index].blocks.map(({ id }) => ({ id, text: "完成" })) });
  finish(0);
  await nextTurn();
  assert.equal(transport.calls.length, 2, "far content does not compete with the remaining nearby request");
  finish(1);
  await nextTurn();
  assert.equal(transport.calls.length, 3, "only one remaining-page batch is active");
  assert.deepEqual(transport.calls[2].blocks.map(({ text }) => text), ["Paragraph 3.", "Paragraph 4."]);
  finish(2);
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 6);
});

test("a hidden page finishes existing reading requests and continues the whole page with one active batch", async () => {
  const { dom } = viewportFixture(6);
  const transport = new FakeTransport();
  const gates = Array.from({ length: 3 }, () => deferred<Result<Translation[]>>());
  let active = 0;
  let hiddenPeak = 0;
  transport.responder = async (blocks) => {
    const index = transport.calls.length - 1;
    active++;
    if (index >= 2) hiddenPeak = Math.max(hiddenPeak, active);
    const result = gates[index] ? await gates[index].promise
      : { ok: true as const, result: blocks.map(({ id }) => ({ id, text: "后台继续" })) };
    active--;
    return result;
  };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "hidden-fill", "settings");
  assert.equal(transport.calls.length, 2);
  changeVisibility(dom, "hidden");
  const finish = (index: number) => gates[index].resolve({ ok: true,
    result: transport.calls[index].blocks.map(({ id }) => ({ id, text: "完成" })) });
  finish(0);
  await settleViewport();
  assert.equal(transport.calls.length, 2);
  assert.ok(transport.calls.slice(0, 2).every((call) => !call.options?.signal?.aborted),
    "switching tabs does not throw away existing requests");
  finish(1);
  await nextTurn();
  assert.equal(transport.calls.length, 3);
  finish(2);
  await translator.whenIdle();
  assert.equal(hiddenPeak, 1);
  assert.equal(translator.getState().completed, 6);
});

test("returning to a page prioritizes the current screen and rejects cancelled background previews", async () => {
  const { dom, scroll } = viewportFixture(8);
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = async (blocks) => transport.calls.length === 3 ? pending.promise
    : { ok: true, result: blocks.map(({ id }) => ({ id, text: "完成" })) };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "return-to-reading", "settings");
  await nextTurn();
  const background = transport.calls[2];
  assert.ok(background);
  changeVisibility(dom, "hidden");
  scroll(7_000);
  await settleViewport();
  assert.equal(background.options?.signal?.aborted, false, "hidden-page changes retain useful background work");
  const cohorts = translator.getDiagnostics().filter(({ stage }) => stage === "reading.started").length;
  changeVisibility(dom, "visible");
  await translator.whenIdle();
  assert.equal(background.options?.signal?.aborted, true);
  assert.equal(transport.calls[3].blocks[0].text, "Paragraph 8.");
  assert.equal(translator.getDiagnostics().filter(({ stage }) => stage === "reading.started").length, cohorts,
    "visibility restoration is not a synthetic reading scroll");
  background.options?.onProgress?.([{ id: background.blocks[0].id, text: "过期后台预览" }]);
  pending.resolve({ ok: true, result: background.blocks.map(({ id }) => ({ id, text: "过期后台结果" })) });
  await nextTurn();
  assert.doesNotMatch(dom.window.document.body.textContent ?? "", /过期后台/);
  assert.equal(translator.getState().completed, 8);
});

test("scrolling within an already translated screen does not cancel remaining-page work", async () => {
  const { dom, scroll } = viewportFixture(5, 2_000);
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = async (blocks) => transport.calls.length === 2 ? pending.promise
    : { ok: true, result: blocks.map(({ id }) => ({ id, text: "完成" })) };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "stable-background", "settings");
  await nextTurn();
  const background = transport.calls[1];
  scroll(-100);
  await settleViewport();
  assert.equal(background.options?.signal?.aborted, false, "no new visible paragraph requires preemption");
  pending.resolve({ ok: true, result: background.blocks.map(({ id }) => ({ id, text: "后台完成" })) });
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 5);
  assert.equal(translator.getDiagnostics().some(({ stage }) => stage === "batch.cancelDistant"), false);
});

test("a newly discovered visible paragraph uses the idle worker before a long request finishes", async () => {
  const dom = pageDom(`<main><p>${"Long source. ".repeat(60)}</p></main>`);
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = async (blocks) => transport.calls.length === 1 ? pending.promise
    : { ok: true, result: blocks.map(({ id }) => ({ id, text: "新段落已完成" })) };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "wake-idle-worker", "settings");
  assert.equal(transport.calls.length, 1);
  const extra = dom.window.document.createElement("p");
  extra.textContent = "Newly arrived paragraph.";
  dom.window.document.querySelector("main")!.append(extra);
  await settleViewport();
  assert.equal(transport.calls.length, 2, "dynamic work can use the second slot while the original request is unresolved");
  assert.equal(transport.calls[1].blocks[0].text, extra.firstChild?.textContent);
  assert.equal(transport.calls[0].options?.signal?.aborted, false);
  assert.equal(translator.getState().completed, 1);
  pending.resolve({ ok: true, result: transport.calls[0].blocks.map(({ id }) => ({ id, text: "长段落完成" })) });
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 2);
});

test("stop and restore prevent visibility and queued discovery from reviving remaining-page work", async () => {
  for (const action of ["stop", "restore"] as const) {
    const { dom, scroll } = viewportFixture(5);
    const transport = new FakeTransport();
    transport.responder = () => new Promise(() => undefined);
    const translator = new PageTranslator(dom.window.document, transport);
    translator.handle("start", `visibility-${action}`, "settings");
    changeVisibility(dom, "hidden");
    const extra = dom.window.document.createElement("p");
    extra.textContent = "Should not resume after an explicit stop.";
    dom.window.document.querySelector("main")!.append(extra);
    translator.handle(action);
    const calls = transport.calls.length;
    changeVisibility(dom, "visible");
    scroll(3_000);
    await translator.whenIdle();
    assert.equal(transport.calls.length, calls);
    assert.ok(transport.calls.every((call) => call.options?.signal?.aborted));
    assert.equal(translator.getState().status, action === "stop" ? "stopped" : "idle");
  }
});

test("retranslate bypasses cache while a plain start after restore reuses it", async () => {
  const { dom } = viewportFixture(1);
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "first", "settings");
  await translator.whenIdle();
  translator.handle("retranslate", "fresh", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[1].jobId, "fresh");
  assert.equal(dom.window.document.querySelectorAll("[data-open-web-translator]").length, 1);
  translator.handle("restore");
  translator.handle("start", "cached", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 2);
});

test("an old request cannot overwrite a retranslation", async () => {
  const { dom } = viewportFixture(1);
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = () => pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "old", "settings");
  const oldCall = transport.calls[0];
  oldCall.options?.onProgress?.([{ id: oldCall.blocks[0].id, text: "旧预览" }]);
  transport.responder = async (blocks) => ({ ok: true, result: blocks.map(({ id }) => ({ id, text: "新译文" })) });
  translator.handle("retranslate", "new", "settings");
  await translator.whenIdle();
  oldCall.options?.onProgress?.([{ id: oldCall.blocks[0].id, text: "迟到旧进度" }]);
  pending.resolve({ ok: true, result: [{ id: "block-1.1", text: "旧译文" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]")?.textContent, "新译文");
});

test("translated source nodes keep their output when moved and lose it when hidden", async () => {
  const dom = pageDom("<main><section id='a'><p>Move me.</p></section><section id='b'></section></main>", {
    url: "https://example.com/moving",
  });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "moving", "settings");
  await translator.whenIdle();
  const paragraph = dom.window.document.querySelector("p")!;
  const destination = dom.window.document.getElementById("b")!;
  destination.append(paragraph);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(destination.querySelectorAll("[data-open-web-translator]").length, 1);
  assert.equal(dom.window.document.querySelector("#a [data-open-web-translator]"), null);
  destination.hidden = true;
  await translator.whenIdle();
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
  assert.equal(translator.getState().status, "watching");
  assert.equal(translator.getState().total, 0);
  assert.equal(transport.calls.length, 1);
  destination.hidden = false;
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 1);
  assert.equal(transport.calls.length, 2);
});

test("visible paragraphs stream separately and reuse one safe preview element until final", async () => {
  const { dom } = viewportFixture(1);
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = () => pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "stream", "settings");
  const call = transport.calls[0];
  assert.equal(call.blocks.length, 1);
  call.options?.onProgress?.([{ id: call.blocks[0].id, text: "部分" }]);
  const preview = dom.window.document.querySelector("[data-open-web-translator]");
  assert.equal(preview?.textContent, "部分");
  assert.equal(preview?.getAttribute("aria-busy"), "true");
  assert.equal(translator.getState().completed, 0);
  call.options?.onProgress?.([
    { id: "unknown", text: "忽略" },
    { id: call.blocks[0].id, text: "部分 <img src=x onerror=alert(1)>" },
  ]);
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), preview);
  assert.equal(preview?.querySelector("img"), null);
  assert.equal(preview?.textContent, "部分 <img src=x onerror=alert(1)>");
  pending.resolve({ ok: true, result: [{ id: call.blocks[0].id, text: "完整译文" }] });
  await translator.whenIdle();
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), preview);
  assert.equal(preview?.textContent, "完整译文");
  assert.equal(preview?.hasAttribute("aria-busy"), false);
  assert.equal(translator.getState().completed, 1);
});

test("a failed streamed paragraph rolls back its preview and cannot populate the cache", async () => {
  const { dom } = viewportFixture(1);
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = () => pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "failed-stream", "settings");
  const call = transport.calls[0];
  call.options?.onProgress?.([{ id: call.blocks[0].id, text: "未完成预览" }]);
  pending.resolve({ ok: false, error: { code: "INCOMPLETE_RESPONSE", message: "连接提前结束" } });
  await translator.whenIdle();
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
  assert.equal(translator.getState().completed, 0);
  assert.equal(translator.getState().failed, 1);
  transport.responder = async (blocks) => ({
    ok: true, result: blocks.map(({ id }) => ({ id, text: "重试完成" })),
  });
  translator.handle("retry", "retry-stream", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 2);
  translator.handle("restore");
  translator.handle("start", "cached-stream", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 2);
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]")?.textContent, "重试完成");
});

test("scroll aborts distant requests and dispatches the new window before old promises settle", async () => {
  const { dom, scroll } = viewportFixture(10, 400);
  const transport = new FakeTransport();
  const old = [deferred<Result<Translation[]>>(), deferred<Result<Translation[]>>()];
  let active = 0;
  let peak = 0;
  let index = 0;
  transport.responder = async (blocks, options) => {
    active++;
    peak = Math.max(peak, active);
    const pending = old[index++];
    if (pending) {
      options?.signal?.addEventListener("abort", () => { active--; }, { once: true });
      return pending.promise;
    }
    active--;
    return { ok: true, result: blocks.map(({ id }) => ({ id, text: `新窗口 ${id}` })) };
  };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "scroll-stream", "settings");
  assert.equal(transport.calls.length, 2);
  const [first, second] = transport.calls;
  first.options?.onProgress?.([{ id: first.blocks[0].id, text: "旧窗口预览" }]);
  scroll(2_800);
  await translator.whenIdle();
  assert.equal(first.options?.signal?.aborted, true);
  assert.equal(second.options?.signal?.aborted, true);
  assert.equal(transport.calls[2].blocks[0].text, "Paragraph 8.");
  assert.equal(peak, 2);
  assert.doesNotMatch(dom.window.document.body.textContent ?? "", /旧窗口预览/);
  first.options?.onProgress?.([{ id: first.blocks[0].id, text: "迟到进度" }]);
  old[0].resolve({ ok: true, result: [{ id: first.blocks[0].id, text: "迟到结果" }] });
  old[1].resolve({ ok: true, result: [{ id: second.blocks[0].id, text: "迟到结果" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.doesNotMatch(dom.window.document.body.textContent ?? "", /迟到/);
  assert.equal(translator.getState().failed, 0);
  scroll(0);
  await translator.whenIdle();
  assert.equal(transport.calls.filter((call) => call.blocks[0].id === first.blocks[0].id).length, 2);
});

test("visible short blocks batch three before two-block prefetch", async () => {
  const { dom } = viewportFixture(6, 300);
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "batching", "settings");
  await translator.whenIdle();
  assert.deepEqual(transport.calls.slice(0, 3).map((call) => call.blocks.map((block) => block.text)), [
    ["Paragraph 1.", "Paragraph 2.", "Paragraph 3."], ["Paragraph 4.", "Paragraph 5."], ["Paragraph 6."],
  ]);
});

test("same-screen dominant article starts before surrounding headings without dropping other ranges", async () => {
  const headings = Array.from({ length: 6 }, (_, index) => `File heading ${index + 1}`);
  const prose = Array.from({ length: 6 }, (_, index) => `Article paragraph ${index + 1}. ${"Readable prose. ".repeat(7)}`.trim());
  const metadata = "File metadata remains eligible content.";
  const dom = pageDom(`<main>${headings.map((text) => `<h2>${text}</h2>`).join("")}
    <div>${metadata}</div><article>${prose.map((text) => `<p>${text}</p>`).join("")}</article></main>`,
  { url: "https://example.com/article-priority" });
  const original = dom.window.document.querySelector("main")!.innerHTML;
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "article-priority", "settings");
  await translator.whenIdle();
  assert.deepEqual(transport.calls.slice(0, 2).flatMap((call) => call.blocks.map((block) => block.text)), prose);
  const requested = transport.calls.flatMap((call) => call.blocks.map((block) => block.text));
  assert.deepEqual([...requested].sort(), [...headings, metadata, ...prose].sort());
  assert.equal(translator.getState().completed, requested.length);
  translator.handle("restore");
  assert.equal(dom.window.document.querySelector("main")!.innerHTML, original);
});

test("visible surrounding content still precedes a dominant article in the prefetch window", async () => {
  const body = "Article prose. ".repeat(40).trim();
  const dom = pageDom(`<main><p>Visible summary.</p><article><p>${body}</p></article></main>`,
    { url: "https://example.com/priority-viewport" });
  Object.defineProperty(dom.window, "innerHeight", { value: 800 });
  dom.window.document.querySelector("main > p")!.getBoundingClientRect = () => ({ top: 20, bottom: 80 } as DOMRect);
  dom.window.document.querySelector("article p")!.getBoundingClientRect = () => ({ top: 1_000, bottom: 1_080 } as DOMRect);
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "priority-viewport", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls[0].blocks[0].text, "Visible summary.");
  assert.equal(transport.calls[1].blocks[0].text, body);
});

test("dynamic article growth refreshes priorities on unchanged pending ranges", async () => {
  const headings = Array.from({ length: 6 }, (_, index) => `<h2>File heading ${index + 1}</h2>`).join("");
  const prose = Array.from({ length: 6 }, (_, index) => `Original article paragraph ${index + 1}.`);
  const dom = pageDom(`<main>${headings}<div>File metadata remains eligible content.</div>
    <article>${prose.map((text) => `<p>${text}</p>`).join("")}</article></main>`,
  { url: "https://example.com/dynamic-priority" });
  let top = 5_000;
  const rect = () => ({ top, bottom: top + 80 } as DOMRect);
  for (const element of dom.window.document.querySelectorAll("main *")) element.getBoundingClientRect = rect;
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = async (blocks) => transport.calls.length === 1 ? pending.promise
    : { ok: true, result: blocks.map(({ id }) => ({ id, text: "完成" })) };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "dynamic-priority", "settings");
  assert.equal(transport.calls.length, 1, "background fill leaves one slot free");
  const extra = dom.window.document.createElement("p");
  extra.textContent = "New substantial article content. ".repeat(15).trim();
  extra.getBoundingClientRect = rect;
  dom.window.document.querySelector("article")!.append(extra);
  await settleViewport();
  top = 20;
  dom.window.document.dispatchEvent(new dom.window.Event("scroll"));
  await settleViewport();
  pending.resolve({ ok: true, result: transport.calls[0].blocks.map(({ id }) => ({ id, text: "已开始的文件标题" })) });
  await translator.whenIdle();
  assert.deepEqual(transport.calls.slice(1, 3).flatMap((call) => call.blocks.map((block) => block.text)), prose);
  assert.equal(translator.getState().completed, 14);
});

test("long paragraphs show only a contiguous prefix when chunks arrive out of order", async () => {
  const dom = pageDom(`<main><p>${"x".repeat(3_000)}</p></main>`, { url: "https://example.com/chunks" });
  const transport = new FakeTransport();
  const pending = [deferred<Result<Translation[]>>(), deferred<Result<Translation[]>>()];
  let index = 0;
  transport.responder = () => pending[index++].promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "chunk-stream", "settings");
  const [first, second] = transport.calls;
  second.options?.onProgress?.([{ id: second.blocks[0].id, text: "第二段" }]);
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
  pending[1].resolve({ ok: true, result: [{ id: second.blocks[0].id, text: "第二段完成" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
  first.options?.onProgress?.([{ id: first.blocks[0].id, text: "第一段" }]);
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]")?.textContent, "第一段");
  assert.equal(translator.getState().completed, 0);
  pending[0].resolve({ ok: true, result: [{ id: first.blocks[0].id, text: "第一段完成" }] });
  await translator.whenIdle();
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]")?.textContent, "第一段完成第二段完成");
  assert.equal(translator.getState().completed, 1);
});

test("a failed final chunk removes the completed prefix and retry retranslates the whole paragraph", async () => {
  const dom = pageDom(`<main><p>${"x".repeat(3_000)}</p></main>`, { url: "https://example.com/chunk-failure" });
  const transport = new FakeTransport();
  const pending = [deferred<Result<Translation[]>>(), deferred<Result<Translation[]>>()];
  let index = 0;
  transport.responder = () => pending[index++].promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "prefix", "settings");
  const [first, second] = transport.calls;
  pending[0].resolve({ ok: true, result: [{ id: first.blocks[0].id, text: "已完成前缀" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  second.options?.onProgress?.([{ id: second.blocks[0].id, text: "未完成后缀" }]);
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]")?.textContent, "已完成前缀未完成后缀");
  pending[1].resolve({ ok: false, error: { code: "INCOMPLETE_RESPONSE", message: "后缀失败" } });
  await translator.whenIdle();
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
  assert.equal(translator.getState().failed, 1);
  transport.responder = async (blocks) => ({
    ok: true, result: blocks.map(({ id }) => ({ id, text: "重试完成" })),
  });
  translator.handle("retry", "prefix-retry", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 4);
  assert.equal(translator.getState().completed, 1);
});

test("stop and restore remove previews and reject later progress", async () => {
  for (const action of ["stop", "restore"] as const) {
    const { dom } = viewportFixture(1);
    const transport = new FakeTransport();
    const pending = deferred<Result<Translation[]>>();
    transport.responder = () => pending.promise;
    const translator = new PageTranslator(dom.window.document, transport);
    translator.handle("start", `preview-${action}`, "settings");
    const call = transport.calls[0];
    call.options?.onProgress?.([{ id: call.blocks[0].id, text: "未完成预览" }]);
    translator.handle(action);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
    call.options?.onProgress?.([{ id: call.blocks[0].id, text: "迟到进度" }]);
    pending.resolve({ ok: true, result: [{ id: call.blocks[0].id, text: "迟到结果" }] });
    await translator.whenIdle();
    assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
  }
});

test("resize and layout changes do not abort a paragraph already streaming", async () => {
  const { dom } = viewportFixture(1);
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = () => pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "layout", "settings");
  const call = transport.calls[0];
  dom.window.document.querySelector("p")!.getBoundingClientRect = () => ({
    top: -10_000, bottom: -9_920,
  } as DOMRect);
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(call.options?.signal?.aborted, false);
  pending.resolve({ ok: true, result: [{ id: call.blocks[0].id, text: "完成" }] });
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 1);
});

test("an empty enabled page watches for appended content, an empty body and body replacement", async () => {
  const dom = pageDom("<main></main>", { url: "https://example.com/dynamic" });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  assert.equal(translator.handle("start", "dynamic", "settings").status, "watching");
  assert.match(translator.getState().message, /等待页面正文/);
  const main = dom.window.document.querySelector("main")!;
  main.innerHTML = "<p>Asynchronously loaded article.</p>";
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 1);
  assert.equal(transport.calls[0].blocks[0].id, "block-1.1");
  main.replaceChildren();
  await translator.whenIdle();
  assert.equal(translator.getState().status, "watching");
  assert.equal(translator.getState().total, 0);
  main.innerHTML = "<p>Another asynchronous article.</p>";
  await translator.whenIdle();
  assert.equal(transport.calls[1].blocks[0].id, "block-2.1");
  const body = dom.window.document.createElement("body");
  body.innerHTML = "<article><p>Replaced body article.</p></article>";
  dom.window.document.body.replaceWith(body);
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 1);
  assert.equal(transport.calls[2].blocks[0].id, "block-3.1");
  assert.equal(dom.window.document.querySelectorAll("[data-open-web-translator]").length, 1);
});

test("source edits cancel a shared batch, requeue its unchanged peers and reject old callbacks", async () => {
  const dom = pageDom("<main><p>Original.</p><p>Peer two.</p><p>Peer three.</p></main>", {
    url: "https://example.com/shared-dynamic",
  });
  const transport = new FakeTransport();
  const old = deferred<Result<Translation[]>>();
  transport.responder = (blocks) => transport.calls.length === 1 ? old.promise : Promise.resolve({
    ok: true, result: blocks.map(({ id, text }) => ({ id, text: `当前：${text}` })),
  });
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "shared", "settings");
  const oldCall = transport.calls[0];
  assert.equal(oldCall.blocks.length, 3);
  oldCall.options?.onProgress?.(oldCall.blocks.map(({ id }) => ({ id, text: "旧预览" })));
  dom.window.document.querySelector("p")!.firstChild!.textContent = "Updated.";
  await translator.whenIdle();
  assert.equal(oldCall.options?.signal?.aborted, true);
  assert.equal(translator.getState().completed, 3);
  assert.equal(translator.getState().failed, 0);
  assert.ok(transport.calls.slice(1).flatMap(({ blocks }) => blocks).some(({ id }) => id === "block-1.v2.1"));
  oldCall.options?.onProgress?.(oldCall.blocks.map(({ id }) => ({ id, text: "迟到进度" })));
  old.resolve({ ok: true, result: oldCall.blocks.map(({ id }) => ({ id, text: "迟到结果" })) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.doesNotMatch(dom.window.document.body.textContent ?? "", /旧预览|迟到/);
  assert.match(dom.window.document.body.textContent ?? "", /当前：Updated\./);
  const completedCalls = transport.calls.length;
  translator.handle("restore");
  translator.handle("start", "shared-cached", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, completedCalls);
});

test("rapid changes coalesce discovery and a reverted source still gets a fresh version", async () => {
  const dom = pageDom("<main><p>Original.</p></main>", { url: "https://example.com/rapid" });
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = (blocks) => transport.calls.length === 1 ? pending.promise : Promise.resolve({
    ok: true, result: blocks.map(({ id }) => ({ id, text: "最新版本" })),
  });
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "rapid", "settings");
  const source = dom.window.document.querySelector("p")!;
  source.textContent = "Intermediate.";
  await new Promise((resolve) => setTimeout(resolve, 0));
  source.textContent = "Another intermediate.";
  source.textContent = "Original.";
  await translator.whenIdle();
  assert.equal(transport.calls.length, 2);
  assert.notEqual(transport.calls[1].blocks[0].id, transport.calls[0].blocks[0].id);
  assert.equal(transport.calls[1].blocks[0].text, "Original.");
  const discoveries = translator.getDiagnostics().filter(({ stage }) => stage === "extraction.dynamic");
  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0].values?.candidates, 1);
  assert.equal(typeof discoveries[0].values?.durationMs, "number");
  pending.resolve({ ok: true, result: [{ id: "block-1.1", text: "旧版本" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]")?.textContent, "最新版本");
});

test("removing an inflight source rejects its late result and does not cache it", async () => {
  const dom = pageDom("<main><p>Detached source.</p></main>", { url: "https://example.com/remove" });
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = () => pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "remove", "settings");
  const source = dom.window.document.querySelector("p")!;
  source.remove();
  await translator.whenIdle();
  assert.equal(transport.calls[0].options?.signal?.aborted, true);
  assert.equal(translator.getState().total, 0);
  pending.resolve({ ok: true, result: [{ id: "block-1.1", text: "已删除的旧结果" }] });
  transport.responder = async (blocks) => ({ ok: true, result: blocks.map(({ id }) => ({ id, text: "重新登记" })) });
  dom.window.document.querySelector("main")!.append(source);
  await translator.whenIdle();
  assert.equal(transport.calls[1].blocks[0].id, "block-1.v2.1");
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]")?.textContent, "重新登记");
});

test("stop and restore prevent both queued and later dynamic discoveries from restarting", async () => {
  for (const action of ["stop", "restore"] as const) {
    const dom = pageDom("<main></main>", { url: "https://example.com/stopped-dynamic" });
    const transport = new FakeTransport();
    const translator = new PageTranslator(dom.window.document, transport);
    translator.handle("start", `dynamic-${action}`, "settings");
    const main = dom.window.document.querySelector("main")!;
    main.innerHTML = "<p>First append.</p>";
    await new Promise((resolve) => setTimeout(resolve, 0));
    translator.handle(action);
    main.insertAdjacentHTML("beforeend", "<p>Second append.</p>");
    await translator.whenIdle();
    assert.equal(transport.calls.length, 0);
    assert.equal(translator.getState().status, action === "stop" ? "stopped" : "idle");
    translator.handle("start", `explicit-${action}`, "settings");
    await translator.whenIdle();
    assert.equal(translator.getState().completed, 2);
  }
});

test("a restart during a discovery debounce still discovers mutations in the new session", async () => {
  const dom = pageDom("<main></main>", { url: "https://example.com/restart-dynamic" });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "first", "settings");
  dom.window.document.querySelector("main")!.innerHTML = "<p>First source.</p>";
  await new Promise((resolve) => setTimeout(resolve, 0));
  translator.handle("start", "second", "settings");
  dom.window.document.querySelector("main")!.insertAdjacentHTML("beforeend", "<p>New session append.</p>");
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 2);
  assert.equal(transport.calls.flatMap(({ blocks }) => blocks).filter(({ text }) => text === "New session append.").length, 1);
});

test("generated streams and unrelated navigation text do not schedule discovery", async () => {
  const dom = pageDom("<nav><span>Navigation.</span></nav><main><p>Source.</p></main>", {
    url: "https://example.com/no-self-scan",
  });
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = () => pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "no-self-scan", "settings");
  const call = transport.calls[0];
  for (const text of ["译", "译文", "译文增量"]) {
    call.options?.onProgress?.([{ id: call.blocks[0].id, text }]);
    await Promise.resolve();
  }
  dom.window.document.querySelector("nav span")!.textContent = "Navigation updated.";
  pending.resolve({ ok: true, result: [{ id: call.blocks[0].id, text: "最终结果" }] });
  await translator.whenIdle();
  assert.equal(translator.getDiagnostics().filter(({ stage }) => stage === "extraction.dynamic").length, 0);
});

test("one visible request can stream independent previews for three blocks before final validation", async () => {
  const { dom } = viewportFixture(3, 100);
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = () => pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "multi-progress", "settings");
  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.equal(call.blocks.length, 3);
  call.options?.onProgress?.([{ id: call.blocks[2].id, text: "第三段预览" }]);
  assert.equal(dom.window.document.querySelectorAll("[data-open-web-translator]").length, 1);
  call.options?.onProgress?.([{ id: call.blocks[0].id, text: "第一段预览" }]);
  assert.equal(dom.window.document.querySelectorAll("[data-open-web-translator]").length, 2);
  assert.equal(translator.getState().completed, 0);
  pending.resolve({ ok: true, result: call.blocks.map(({ id }) => ({ id, text: `完整 ${id}` })) });
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 3);
});

test("a second visible paragraph gets a worker before the first long paragraph gets a second chunk", async () => {
  const dom = pageDom(`<main><p>${"x".repeat(4_500)}</p><p>Other visible paragraph.</p></main>`, {
    url: "https://example.com/fair-chunks",
  });
  const transport = new FakeTransport();
  const gates = [deferred<void>(), deferred<void>()];
  transport.responder = async (blocks) => {
    const gate = gates[transport.calls.length - 1];
    if (gate) await gate.promise;
    return { ok: true, result: blocks.map(({ id }) => ({ id, text: `完成 ${id}` })) };
  };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "fair", "settings");
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0].blocks[0].id, "block-1.1");
  assert.equal(transport.calls[1].blocks[0].id, "block-2.1");
  gates.forEach((gate) => gate.resolve());
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 2);
});

test("translation-only hides only completed safe sources and reversibly preserves original nodes and events", async () => {
  const dom = pageDom("<main><p id='plain' style='color:red'>Source with <em>emphasis</em>.</p></main>", {
    url: "https://example.com/mode",
  });
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = () => pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);
  const source = dom.window.document.querySelector("p")!;
  const emphasis = dom.window.document.querySelector("em");
  const originalNodes = [...source.childNodes];
  let clicks = 0;
  source.addEventListener("click", () => clicks++);
  translator.setDisplayMode("translation-only");
  translator.handle("start", "mode", "settings");
  const call = transport.calls[0];
  call.options?.onProgress?.([{ id: call.blocks[0].id, text: "预览" }]);
  assert.notEqual(dom.window.getComputedStyle(source).display, "none");
  pending.resolve({ ok: true, result: [{ id: call.blocks[0].id, text: "完整结果" }] });
  await translator.whenIdle();
  assert.notEqual(dom.window.getComputedStyle(source).display, "none");
  assert.equal(originalNodes[0].textContent, "");
  assert.equal(originalNodes[2].textContent, "");
  assert.equal(dom.window.getComputedStyle(emphasis!).display, "none");
  assert.equal(source.querySelector("[data-open-web-translator]")?.textContent, "完整结果");
  assert.equal(source.getAttribute("style"), "color:red");
  assert.equal(dom.window.document.querySelector("em"), emphasis);
  translator.setDisplayMode("bilingual");
  await translator.whenIdle();
  assert.notEqual(dom.window.getComputedStyle(source).display, "none");
  assert.deepEqual([...source.childNodes].filter((node) => !(node instanceof dom.window.Element && node.hasAttribute("data-open-web-translator"))), originalNodes);
  source.click();
  assert.equal(clicks, 1);
  translator.setDisplayMode("translation-only");
  translator.handle("restore");
  await translator.whenIdle();
  assert.notEqual(dom.window.getComputedStyle(source).display, "none");
  assert.equal(source.getAttribute("style"), "color:red");
  assert.deepEqual([...source.childNodes], originalNodes);
  assert.equal(transport.calls.length, 1);
  translator.handle("start", "mode-cache", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 1);
  assert.notEqual(dom.window.getComputedStyle(source).display, "none");
  assert.equal(dom.window.getComputedStyle(emphasis!).display, "none");
});

test("translation-only downgrades interactive and nested-list sources without losing link events", async () => {
  const dom = pageDom(`<main><p>Read <a href='#more'>the source</a>.</p>
    <ul><li>Parent item.<ul><li>Child item.</li></ul></li></ul></main>`, {
    url: "https://example.com/safe-mode",
  });
  const link = dom.window.document.querySelector("a")!;
  let clicks = 0;
  link.addEventListener("click", (event) => { event.preventDefault(); clicks++; });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.setDisplayMode("translation-only");
  translator.handle("start", "safe-mode", "settings");
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 3);
  assert.equal(dom.window.document.querySelectorAll("[data-open-web-translator-source-hidden]").length, 0);
  assert.equal(dom.window.document.querySelector("a"), link);
  link.click();
  assert.equal(clicks, 1);
  assert.deepEqual(transport.calls.flatMap(({ blocks }) => blocks).map(({ text }) => text), [
    "Read the source.", "Parent item.", "Child item.",
  ]);
});

test("translation-only does not mistake its hiding for a source edit but observes host changes", async () => {
  const dom = pageDom("<main><p>Original source.</p></main>", { url: "https://example.com/hidden-source" });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.setDisplayMode("translation-only");
  translator.handle("start", "hidden-source", "settings");
  await translator.whenIdle();
  const source = dom.window.document.querySelector("p")!;
  dom.window.document.querySelector("main")!.append(dom.window.document.createElement("hr"));
  await translator.whenIdle();
  assert.equal(transport.calls.length, 1);
  source.textContent = "Host changed source.";
  await translator.whenIdle();
  assert.equal(transport.calls.length, 2);
  assert.equal(translator.getState().completed, 1);
  assert.match(dom.window.document.querySelector("[data-open-web-translator]")?.textContent ?? "", /Host changed source/);
  source.style.display = "none";
  await translator.whenIdle();
  assert.equal(translator.getState().total, 0);
  translator.handle("restore");
  assert.equal(source.style.display, "none");
});

test("viewport settled measures visible completion without waiting for prefetch", async () => {
  const { dom } = viewportFixture(3, 1_000);
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = (blocks) => blocks[0].text === "Paragraph 2." ? pending.promise
    : Promise.resolve({ ok: true, result: blocks.map(({ id }) => ({ id, text: "可见段完成" })) });
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "visible-timing", "settings");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(translator.getState().status, "running");
  const settled = translator.getDiagnostics().filter(({ stage }) => stage === "viewport.settled");
  assert.equal(settled.length, 1);
  assert.equal(settled[0].values?.blocks, 1);
  assert.equal(settled[0].values?.failed, 0);
  pending.resolve({ ok: true, result: [{ id: transport.calls[1].blocks[0].id, text: "预取完成" }] });
  await translator.whenIdle();
  assert.equal(translator.getDiagnostics().filter(({ stage }) => stage === "viewport.settled").length, 1);
});

function readingGeometry(dom: JSDOM, topOf: (node: Node) => number) {
  const rect = (top: number) => ({ top, bottom: top + 80, left: 0, right: 500, width: 500, height: 80 } as DOMRect);
  Object.defineProperty(dom.window.Range.prototype, "getClientRects", { value: function (this: Range) {
    return [rect(topOf(this.startContainer.childNodes[this.startOffset]))];
  } });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return rect(topOf(this)); };
}

test("reading cohort retains initial ranges when translated layout moves unfinished text offscreen", async () => {
  const dom = pageDom(`<main><p id="first">${"First source. ".repeat(60)}</p><p id="second">${"Second source. ".repeat(60)}</p></main>`);
  let secondTop = 200;
  readingGeometry(dom, (node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest("#second") ? secondTop : 0);
  const transport = new FakeTransport();
  const pending = [deferred<Result<Translation[]>>(), deferred<Result<Translation[]>>()];
  transport.responder = (blocks) => pending[blocks[0].text.startsWith("First") ? 0 : 1].promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "reading-layout", "settings");
  assert.equal(transport.calls.length, 2);
  const events = (stage: string) => translator.getDiagnostics().filter((event) => event.stage === stage);
  assert.equal(events("reading.started")[0].values?.blocks, 2);
  transport.calls[0].options?.onProgress?.([{ id: transport.calls[0].blocks[0].id, text: "第一段预览" }]);
  assert.equal(events("reading.firstVisible").length, 1);
  secondTop = 2_500; // Output layout expansion; the reader did not scroll.
  pending[0].resolve({ ok: true, result: [{ id: transport.calls[0].blocks[0].id, text: "第一段完成" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.dispatchEvent(new dom.window.Event("resize"));
  dom.window.document.querySelector("main")!.append(dom.window.document.createElement("hr"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(events("reading.started").length, 1, "resize and dynamic discovery cannot reset a reading cohort");
  assert.equal(events("reading.completed").length, 0, "offscreen unfinished source remains in the fixed initial cohort");
  pending[1].resolve({ ok: true, result: [{ id: transport.calls[1].blocks[0].id, text: "第二段完成" }] });
  await translator.whenIdle();
  const completed = events("reading.completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].values?.blocks, 2);
  assert.equal(completed[0].values?.completed, 2);
  assert.equal(completed[0].values?.pending, 0);
  assert.equal(completed[0].values?.failed, 0);
});

test("scroll cohorts report prefetched completion and measure new visible text once per merged scroll", async () => {
  const dom = pageDom('<main><p id="p0">Paragraph zero.</p><p id="p1">Paragraph one.</p><p id="p2">Paragraph two.</p></main>');
  let offset = 0;
  readingGeometry(dom, (node) => {
    const parent = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest("p");
    return Number(parent?.id.slice(1) ?? 0) * 1_000 - offset;
  });
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = async (blocks) => blocks[0].text === "Paragraph two." ? pending.promise
    : { ok: true, result: blocks.map(({ id }) => ({ id, text: "已预取" })) };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "reading-scroll", "settings");
  await nextTurn();
  assert.equal(translator.getState().completed, 2);
  const scroll = (value: number) => { offset = value; dom.window.document.dispatchEvent(new dom.window.Event("scroll")); };
  const events = (stage: string) => translator.getDiagnostics().filter((event) => event.stage === stage);
  scroll(1_000);
  scroll(1_010);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(events("reading.started").length, 2);
  const warm = events("reading.started")[1];
  assert.equal(warm.values?.fromScroll, true);
  assert.equal(warm.values?.alreadyCompleted, 1);
  assert.equal(warm.values?.availableAtStart, 1);
  assert.equal(warm.values?.pending, 0);
  scroll(2_000);
  const request = transport.calls.find((call) => call.blocks[0].text === "Paragraph two.")!;
  request.options?.onProgress?.([{ id: request.blocks[0].id, text: "新屏首字" }]);
  request.options?.onProgress?.([{ id: request.blocks[0].id, text: "新屏首字继续" }]);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(events("reading.started").length, 3);
  const cold = events("reading.started")[2];
  assert.equal(cold.values?.pending, 1);
  const first = events("reading.firstVisible").filter((event) => event.values?.epoch === cold.values?.epoch);
  assert.equal(first.length, 1);
  assert.equal(first[0].values?.observedBeforeCapture, true, "progress during scroll coalescing is replayed for the final viewport");
  assert.equal(cold.values?.availableAtStart, 0);
  assert.equal(cold.values?.availableAtCapture, 1);
  assert.ok(Number(first[0].values?.durationMs) < Number(cold.values?.captureDelayMs), "first text timing keeps the first scroll origin, not the later capture time");
  assert.equal(first[0].values?.pending, 1, "a preview is not final completion");
  pending.resolve({ ok: true, result: [{ id: request.blocks[0].id, text: "新屏完成" }] });
  await translator.whenIdle();
  const done = events("reading.completed").find((event) => event.values?.epoch === cold.values?.epoch)!;
  assert.equal(done.values?.completed, 1);
  assert.ok(Number(done.values?.durationMs) >= Number(first[0].values?.durationMs));
});

test("a merged scroll selects the final viewport instead of reporting the already translated intermediate screen", async () => {
  const { dom, scroll } = viewportFixture(3);
  const pending = deferred<Result<Translation[]>>();
  const transport = new FakeTransport();
  transport.responder = async (blocks) => blocks[0].text === "Paragraph 3." ? pending.promise
    : { ok: true, result: blocks.map(({ id }) => ({ id, text: "中间屏已完成" })) };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "reading-final-scroll", "settings");
  await nextTurn();
  assert.equal(translator.getState().completed, 2);
  scroll(1_000);
  scroll(2_000);
  await new Promise((resolve) => setTimeout(resolve, 45));
  const starts = translator.getDiagnostics().filter(({ stage }) => stage === "reading.started");
  assert.equal(starts.length, 2);
  const final = starts[1];
  assert.equal(final.values?.blocks, 1);
  assert.equal(final.values?.alreadyCompleted, 0, "the cached intermediate screen is not the selected cohort");
  assert.equal(final.values?.pending, 1);
  assert.ok(Number(final.values?.captureDelayMs) >= 30, "reported timing includes the coalescing window");
  assert.equal(translator.getDiagnostics().some((event) => event.stage === "reading.completed" && event.values?.epoch === final.values?.epoch), false);
  const request = transport.calls.find(({ blocks }) => blocks[0].text === "Paragraph 3.")!;
  pending.resolve({ ok: true, result: [{ id: request.blocks[0].id, text: "最终屏完成" }] });
  await translator.whenIdle();
  const completed = translator.getDiagnostics().find((event) => event.stage === "reading.completed" && event.values?.epoch === final.values?.epoch)!;
  assert.equal(completed.values?.completed, 1);
  assert.ok(Number(completed.values?.durationMs) >= Number(final.values?.captureDelayMs));
});

test("reading completion reports failures and invalidated versions without replacing its initial cohort", async () => {
  const dom = pageDom(`<main><p id="failed">${"Failure source. ".repeat(50)}</p><p id="removed">${"Removed source. ".repeat(50)}</p></main>`);
  readingGeometry(dom, () => 100);
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = async (blocks) => blocks[0].text.startsWith("Failure")
    ? { ok: false, error: { code: "NETWORK_ERROR", message: "fixture" } } : pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "reading-failure", "settings");
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.document.querySelector("#removed")!.remove();
  await translator.whenIdle();
  const completed = translator.getDiagnostics().find((event) => event.stage === "reading.completed")!;
  assert.equal(completed.values?.blocks, 2);
  assert.equal(completed.values?.failed, 1);
  assert.equal(completed.values?.invalidated, 1);
  assert.equal(completed.values?.pending, 0);
  assert.equal(completed.values?.completed, 0);
  assert.equal(translator.getDiagnostics().filter((event) => event.stage === "reading.started").length, 1);
});

test("reading geometry excludes a parent list introduction whose nested list spans the viewport", async () => {
  const dom = pageDom('<main><ul><li id="parent">Parent introduction.<ul><li id="child">Visible child paragraph.</li></ul></li></ul></main>');
  readingGeometry(dom, (node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest("#child") ? 100 : -600);
  dom.window.document.querySelector<HTMLElement>("#parent")!.getBoundingClientRect = () => ({ top: -600, bottom: 900, width: 500, height: 1_500 } as DOMRect);
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "reading-range", "settings");
  await translator.whenIdle();
  const started = translator.getDiagnostics().find((event) => event.stage === "reading.started")!;
  assert.equal(started.values?.blocks, 1, "Range geometry, not the outer li rectangle, selects the reading cohort");
  assert.equal(transport.calls[0].blocks[0].text, "Visible child paragraph.", "the visible child is scheduled before its distant parent introduction");
  assert.equal(translator.getState().completed, 2, "the parent introduction is filled after the reading window");
});

test("leaving a reading cohort interrupts its pending measurement instead of reporting successful completion", async () => {
  const { dom, scroll } = viewportFixture(5);
  const transport = new FakeTransport();
  transport.responder = () => new Promise(() => undefined);
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "reading-interrupt", "settings");
  scroll(3_000);
  translator.handle("restore");
  await translator.whenIdle();
  const events = translator.getDiagnostics();
  assert.equal(events.filter((event) => event.stage === "reading.completed").length, 0);
  const interrupted = events.filter((event) => event.stage === "reading.interrupted");
  assert.equal(interrupted.length, 1);
  assert.ok(interrupted.every((event) => Number(event.values?.pending) > 0));
  assert.equal(events.filter((event) => event.stage === "reading.captureCancelled").length, 1, "restore before capture cannot invent a final viewport cohort");
});

test("a pending scroll capture cannot restart measurement after stop or restore", async () => {
  for (const action of ["stop", "restore"] as const) {
    const { dom, scroll } = viewportFixture(4);
    const transport = new FakeTransport();
    transport.responder = () => new Promise(() => undefined);
    const translator = new PageTranslator(dom.window.document, transport);
    translator.handle("start", `capture-${action}`, "settings");
    scroll(2_000);
    translator.handle(action);
    await translator.whenIdle();
    assert.equal(translator.getDiagnostics().filter(({ stage }) => stage === "reading.started").length, 1, action);
    assert.equal(translator.getDiagnostics().filter(({ stage }) => stage === "reading.captureCancelled").length, 1, action);
  }
});

test("a stale scroll timer cannot interrupt the initial cohort of a new retranslation", async () => {
  const { dom, scroll } = viewportFixture(4);
  const transport = new FakeTransport();
  transport.responder = () => new Promise(() => undefined);
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "capture-old", "settings");
  scroll(2_000);
  translator.handle("retranslate", "capture-new", "settings");
  await new Promise((resolve) => setTimeout(resolve, 45));
  const events = translator.getDiagnostics().filter(({ jobId }) => jobId === "capture-new");
  assert.equal(events.filter(({ stage }) => stage === "reading.started").length, 1);
  assert.equal(events.find(({ stage }) => stage === "reading.started")?.values?.fromScroll, false);
  assert.equal(events.some(({ stage }) => stage === "reading.interrupted"), false);
  translator.handle("stop");
  await translator.whenIdle();
});

test("restarting an emptied page resets its counters and remains ready for new content", async () => {
  const dom = pageDom("<main><p>Previous article.</p></main>", { url: "https://example.com/empty-restart" });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "before-empty", "settings");
  await translator.whenIdle();
  dom.window.document.querySelector("main")!.replaceChildren();
  translator.handle("start", "after-empty", "settings");
  assert.equal(translator.getState().total, 0);
  assert.equal(translator.getState().completed, 0);
  assert.equal(translator.getState().status, "watching");
  await translator.whenIdle();
});

test("changing a source region into navigation cancels it and changing it back rediscovers it", async () => {
  const dom = pageDom("<main><section><p>Article text.</p></section></main>", { url: "https://example.com/role" });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "role", "settings");
  await translator.whenIdle();
  const section = dom.window.document.querySelector("section")!;
  section.setAttribute("role", "navigation");
  await translator.whenIdle();
  assert.equal(translator.getState().total, 0);
  assert.equal(dom.window.document.querySelectorAll("[data-open-web-translator]").length, 0);
  section.removeAttribute("role");
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 1);
  assert.equal(transport.calls.length, 2);
});

test("ranges sharing one list item stream next to their own source around a nested list", async () => {
  const dom = pageDom("<main><ul><li id='parent'>Parent introduction.<ul><li>Nested response.</li></ul>Parent conclusion.</li></ul></main>", {
    url: "https://example.com/range-stream",
  });
  const source = dom.window.document.getElementById("parent")!;
  const originalNodes = [...source.childNodes];
  const [introduction, nestedList, conclusion] = originalNodes;
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = () => pending.promise;
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "range-stream", "settings");
  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.deepEqual(call.blocks.map(({ text }) => text), ["Parent introduction.", "Nested response.", "Parent conclusion."]);
  call.options?.onProgress?.([{ id: call.blocks[2].id, text: "结尾预览" }]);
  const conclusionOutput = conclusion.nextSibling as HTMLElement;
  assert.equal(conclusionOutput?.textContent, "结尾预览");
  assert.equal(conclusionOutput?.parentNode, source);
  call.options?.onProgress?.([{ id: call.blocks[0].id, text: "开头预览" }]);
  const introductionOutput = introduction.nextSibling as HTMLElement;
  assert.equal(introductionOutput?.textContent, "开头预览");
  assert.equal(introductionOutput?.nextSibling, nestedList);
  assert.equal(nestedList.nextSibling, conclusion);
  assert.equal(translator.getState().completed, 0);
  pending.resolve({ ok: true, result: call.blocks.map(({ id, text }) => ({ id, text: `完成：${text}` })) });
  await translator.whenIdle();
  assert.equal(introduction.nextSibling, introductionOutput);
  assert.equal(conclusion.nextSibling, conclusionOutput);
  assert.equal(introductionOutput.hasAttribute("aria-busy"), false);
  assert.equal(conclusionOutput.hasAttribute("aria-busy"), false);
  assert.equal(translator.getState().completed, 3);
  translator.handle("restore");
  assert.deepEqual([...source.childNodes], originalNodes);
  assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
});

test("adding, moving or removing a block boundary rejects same-text inflight ranges", async () => {
  for (const action of ["add", "move", "remove"] as const) {
    const dom = pageDom("<main><ul><li id='source'>Original source.<ul id='boundary'><li>Nested source.</li></ul></li></ul></main>", {
      url: `https://example.com/boundary-${action}`,
    });
    const source = dom.window.document.getElementById("source")!;
    const text = source.firstChild!;
    const boundary = dom.window.document.getElementById("boundary")!;
    const transport = new FakeTransport();
    const pending = deferred<Result<Translation[]>>();
    transport.responder = (blocks) => transport.calls.length === 1 ? pending.promise : Promise.resolve({
      ok: true, result: blocks.map(({ id, text }) => ({ id, text: `最新：${text}` })),
    });
    const translator = new PageTranslator(dom.window.document, transport);
    translator.handle("start", `boundary-${action}`, "settings");
    const old = transport.calls[0];
    const originalBlock = old.blocks.find(({ text }) => text === "Original source.")!;
    assert.ok(originalBlock);
    old.options?.onProgress?.([{ id: originalBlock.id, text: "过期预览" }]);
    if (action === "add") source.insertBefore(dom.window.document.createElement("hr"), boundary);
    else if (action === "move") source.append(text);
    else boundary.remove();
    await translator.whenIdle();
    assert.equal(old.options?.signal?.aborted, true, `${action}: invalidate the old anchor`);
    const replacement = transport.calls.slice(1).flatMap(({ blocks }) => blocks).find(({ text }) => text === "Original source.");
    assert.ok(replacement, `${action}: register current range even when its text did not change`);
    assert.notEqual(replacement.id, originalBlock.id);
    old.options?.onProgress?.([{ id: originalBlock.id, text: "迟到预览" }]);
    pending.resolve({ ok: true, result: old.blocks.map(({ id }) => ({ id, text: "迟到完成" })) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /过期|迟到/);
    assert.equal(text.nextSibling?.textContent, "最新：Original source.");
    assert.equal(text.nextSibling?.parentNode, source);
  }
});

test("moving source nodes to a different host invalidates old output and late callbacks", async () => {
  const dom = pageDom("<main><p id='from'>Move <em>this source</em>.</p><p id='to'></p></main>", {
    url: "https://example.com/range-move",
  });
  const source = dom.window.document.getElementById("from")!;
  const destination = dom.window.document.getElementById("to")!;
  const originalNodes = [...source.childNodes];
  const transport = new FakeTransport();
  const pending = deferred<Result<Translation[]>>();
  transport.responder = (blocks) => transport.calls.length === 1 ? pending.promise : Promise.resolve({
    ok: true, result: blocks.map(({ id }) => ({ id, text: "移动后的译文" })),
  });
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "range-move", "settings");
  const old = transport.calls[0];
  old.options?.onProgress?.([{ id: old.blocks[0].id, text: "移动前预览" }]);
  destination.append(...originalNodes);
  await translator.whenIdle();
  assert.equal(old.options?.signal?.aborted, true);
  assert.equal(source.querySelector("[data-open-web-translator]"), null);
  assert.equal(destination.querySelector("[data-open-web-translator]")?.textContent, "移动后的译文");
  assert.equal(translator.getState().completed, 1);
  old.options?.onProgress?.([{ id: old.blocks[0].id, text: "旧位置预览" }]);
  pending.resolve({ ok: true, result: [{ id: old.blocks[0].id, text: "旧位置结果" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.doesNotMatch(dom.window.document.body.textContent ?? "", /移动前|旧位置/);
  translator.handle("restore");
  assert.deepEqual([...destination.childNodes], originalNodes);
  assert.equal(source.childNodes.length, 0);
});

test("nested list and table outputs restore the original nodes, structure and link events", async () => {
  const dom = pageDom(`<main><ul><li id='parent'>Read <a href='#source'>the source</a>.<ul><li>Nested answer.</li></ul>Final note.</li></ul>
    <table><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody><tr><td>Example</td><td>See <a href='#detail'>details</a>.</td></tr></tbody></table></main>`, {
    url: "https://example.com/range-restore",
  });
  const main = dom.window.document.querySelector("main")!;
  const originalHtml = main.innerHTML;
  const elements = [...main.querySelectorAll("*")];
  const links = [...main.querySelectorAll("a")];
  const texts = [...main.querySelectorAll("li, td, th")].flatMap((element) => [...element.childNodes]);
  let clicks = 0;
  for (const link of links) link.addEventListener("click", (event) => { event.preventDefault(); clicks++; });
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "range-restore", "settings");
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 7);
  assert.equal(main.querySelectorAll("td > [data-open-web-translator], th > [data-open-web-translator]").length, 4);
  assert.equal(main.querySelector("table > [data-open-web-translator], tr > [data-open-web-translator]"), null);
  const parent = dom.window.document.getElementById("parent")!;
  assert.equal(parent.querySelector("ul")?.previousSibling?.textContent, "译文：Read the source.");
  translator.handle("restore");
  assert.equal(main.innerHTML, originalHtml);
  assert.deepEqual([...main.querySelectorAll("*")], elements);
  assert.deepEqual([...main.querySelectorAll("li, td, th")].flatMap((element) => [...element.childNodes]), texts);
  for (const link of links) link.click();
  assert.equal(clicks, 2);
});

test("translation-only observes appended source without replacing original text or inline nodes", async () => {
  const dom = pageDom("<main><p id='source'>First text <em>with emphasis</em>.</p></main>", {
    url: "https://example.com/translation-only-append",
  });
  const source = dom.window.document.getElementById("source")!;
  const originalNodes = [...source.childNodes];
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.setDisplayMode("translation-only");
  translator.handle("start", "translation-only-append", "settings");
  await translator.whenIdle();
  const added = dom.window.document.createTextNode(" Appended source.");
  source.append(added);
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 1);
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[1].blocks[0].text, "First text with emphasis. Appended source.");
  assert.notEqual(dom.window.getComputedStyle(source).display, "none");
  assert.match(source.querySelector("[data-open-web-translator]")?.textContent ?? "", /Appended source/);
  translator.handle("restore");
  assert.deepEqual([...source.childNodes], [...originalNodes, added]);
  assert.equal(source.textContent, "First text with emphasis. Appended source.");
  assert.equal(source.querySelector("[data-open-web-translator-source-hidden]"), null);
});

test("translation-only restore preserves a host edit to an existing hidden text node", async () => {
  const dom = pageDom("<main><p id='source'>Original source.</p></main>", {
    url: "https://example.com/translation-only-edit",
  });
  const source = dom.window.document.getElementById("source")!;
  const original = source.firstChild!;
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.setDisplayMode("translation-only");
  translator.handle("start", "translation-only-edit", "settings");
  await translator.whenIdle();
  original.textContent = "Host edited source.";
  translator.handle("restore");
  assert.equal(source.firstChild, original);
  assert.equal(source.textContent, "Host edited source.");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 1);
});

test("cached translations require unchanged range nodes, host and boundaries", async () => {
  const dom = pageDom("<main><ul><li id='source'>Cached source.<ul><li>Unchanged child.</li></ul></li></ul><p id='destination'></p></main>", {
    url: "https://example.com/range-cache",
  });
  const source = dom.window.document.getElementById("source")!;
  const transport = new FakeTransport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "range-cache-first", "settings");
  await translator.whenIdle();
  translator.handle("restore");
  translator.handle("start", "range-cache-unchanged", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 1);
  translator.handle("restore");
  source.firstChild!.replaceWith(dom.window.document.createTextNode("Cached source."));
  translator.handle("start", "range-cache-replaced", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(transport.calls[1].blocks.map(({ text }) => text), ["Cached source."]);
  translator.handle("restore");
  const text = source.firstChild!;
  dom.window.document.getElementById("destination")!.append(text);
  translator.handle("start", "range-cache-moved", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 3);
  assert.deepEqual(transport.calls[2].blocks.map(({ text }) => text), ["Cached source."]);
  translator.handle("restore");
  source.prepend(text);
  translator.handle("start", "range-cache-return", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 4);
  translator.handle("restore");
  source.insertBefore(dom.window.document.createElement("hr"), source.querySelector("ul"));
  translator.handle("start", "range-cache-boundary", "settings");
  await translator.whenIdle();
  assert.equal(transport.calls.length, 5);
  assert.deepEqual(transport.calls[4].blocks.map(({ text }) => text), ["Cached source."]);
});

test("translation-only honors an explicit host clear before discovery or synchronous restore", async () => {
  for (const action of ["discover", "restore"] as const) {
    const dom = pageDom("<main><p>Source the host will clear.</p></main>", {
      url: `https://example.com/translation-only-clear-${action}`,
    });
    const source = dom.window.document.querySelector("p")!;
    const original = source.firstChild!;
    const transport = new FakeTransport();
    const translator = new PageTranslator(dom.window.document, transport);
    translator.setDisplayMode("translation-only");
    translator.handle("start", `clear-${action}`, "settings");
    await translator.whenIdle();
    assert.equal(original.textContent, "");
    // This host write is meaningful even though translation-only already hides
    // the original text using an empty value. Its backup must no longer win.
    original.textContent = "";
    if (action === "restore") translator.handle("restore");
    await translator.whenIdle();
    assert.equal(translator.getState().total, 0);
    assert.equal(dom.window.document.querySelector("[data-open-web-translator]"), null);
    translator.handle("restore");
    assert.equal(source.firstChild, original);
    assert.equal(source.textContent, "");
    translator.handle("start", `clear-restart-${action}`, "settings");
    await translator.whenIdle();
    assert.equal(translator.getState().total, 0);
    assert.equal(transport.calls.length, 1);
  }
});
