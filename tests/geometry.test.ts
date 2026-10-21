import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { collectRanges } from "../src/extension/page/extract.js";
import { sourceRangeBounds, sourceRangeVisible } from "../src/extension/page/ReadingCohort.js";
import { PageTranslator, type TranslationOptions, type TranslationTransport } from "../src/extension/page/PageTranslator.js";
import type { Result, TextBlock, Translation } from "../src/shared/protocol.js";

const box = (top: number, bottom = top + 80) => ({ top, bottom, left: 0, right: 500, width: 500, height: bottom - top } as DOMRect);

function pageDom(html: string): JSDOM {
  return new JSDOM(html, { pretendToBeVisual: true });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function geometry(dom: JSDOM, sourceTop: (node: Node) => number) {
  Object.defineProperty(dom.window.Range.prototype, "getClientRects", { value: function (this: Range) {
    return [box(sourceTop(this.startContainer.childNodes[this.startOffset]))];
  } });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => box(0);
}

class Transport implements TranslationTransport {
  calls: Array<{ blocks: TextBlock[]; options?: TranslationOptions }> = [];
  responder: (blocks: TextBlock[]) => Promise<Result<Translation[]>> = async (blocks) => ({
    ok: true, result: blocks.map(({ id }) => ({ id, text: "完成译文" })),
  });
  translate(_job: string, _revision: string, blocks: TextBlock[], options?: TranslationOptions) {
    this.calls.push({ blocks, options });
    return this.responder(blocks);
  }
  async cancel() {}
}

test("source bounds union only the original sibling run and use output for hidden source", () => {
  const dom = pageDom('<main><li>Parent introduction.<ul><li>Child paragraph.</li></ul>Parent conclusion.</li></main>');
  const ranges = collectRanges(dom.window.document);
  const introduction = ranges.find((range) => range.source === "Parent introduction.")!;
  const conclusion = ranges.find((range) => range.source === "Parent conclusion.")!;
  const observed: Array<{ first: Node; last: Node }> = [];
  Object.defineProperty(dom.window.Range.prototype, "getClientRects", { value: function (this: Range) {
    observed.push({ first: this.startContainer.childNodes[this.startOffset], last: this.endContainer.childNodes[this.endOffset - 1] });
    return [box(-100, -80), box(20, 40)];
  } });
  assert.deepEqual(sourceRangeBounds(introduction), { top: -100, bottom: 40 });
  assert.equal(sourceRangeVisible(introduction), true);
  sourceRangeBounds(conclusion);
  assert.equal(observed[0].first, introduction.nodes[0]);
  assert.equal(observed[0].last, introduction.nodes.at(-1));
  assert.equal(observed[2].first, conclusion.nodes[0]);
  assert.equal(observed[2].last, conclusion.nodes.at(-1));
  const output = dom.window.document.createElement("span");
  output.getBoundingClientRect = () => box(150);
  assert.equal(sourceRangeBounds(introduction, output)?.top, 150);
  assert.equal(observed.length, 3, "hidden originals do not need their source Range measured");
  introduction.nodes[0].parentNode!.removeChild(introduction.nodes[0]);
  assert.equal(sourceRangeBounds(introduction), undefined);
});

test("nested lists prioritize nearby original runs before filling their distant introduction and conclusion", async () => {
  const dom = pageDom('<main><ul><li id="parent">Distant introduction.<ul><li>Visible child.</li></ul>Distant conclusion.</li></ul></main>');
  geometry(dom, (node) => node.textContent?.startsWith("Distant introduction") ? -2_000
    : node.textContent?.startsWith("Distant conclusion") ? 3_000 : 100);
  dom.window.document.querySelector<HTMLElement>("#parent")!.getBoundingClientRect = () => box(-2_000, 3_080);
  const transport = new Transport();
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "range-priority", "settings");
  await translator.whenIdle();
  assert.deepEqual(transport.calls[0].blocks.map(({ text }) => text), ["Visible child."]);
  assert.deepEqual(transport.calls[1].blocks.map(({ text }) => text), ["Distant introduction.", "Distant conclusion."],
    "the parent host does not misclassify distant original runs as visible");
  const settled = translator.getDiagnostics().find(({ stage }) => stage === "viewport.settled")!;
  assert.equal(settled.values?.blocks, 1);
  assert.equal(translator.getState().completed, 3);
  assert.equal(translator.getState().total, 3);
});

test("scroll cancels distant original ranges even while their list hosts still cover the new screen", async () => {
  const dom = pageDom(`<main><ul>${[0, 1].map((index) => `<li id="parent${index}">${`Introduction ${index}. `.repeat(45)}<ul><li id="child${index}">Current screen ${index}.</li></ul></li>`).join("")}</ul></main>`);
  let offset = 0;
  geometry(dom, (node) => {
    const parent = node.parentElement!;
    return (parent.id.startsWith("child") ? 4_000 : 0) + Number(parent.id.at(-1)) * 100 - offset;
  });
  for (const parent of dom.window.document.querySelectorAll<HTMLElement>("[id^=parent]")) {
    parent.getBoundingClientRect = () => box(-offset, 4_180 - offset);
  }
  const transport = new Transport();
  transport.responder = async (blocks) => transport.calls.length <= 2
    ? new Promise(() => undefined)
    : { ok: true, result: blocks.map(({ id }) => ({ id, text: "新屏完成" })) };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "range-cancel", "settings");
  assert.equal(transport.calls.length, 2);
  const original = [...transport.calls];
  offset = 4_000;
  dom.window.document.dispatchEvent(new dom.window.Event("scroll"));
  await translator.whenIdle();
  assert.ok(original.every(({ options }) => options?.signal?.aborted));
  assert.deepEqual(transport.calls[2].blocks.map(({ text }) => text), ["Current screen 0.", "Current screen 1."],
    "the newly visible child ranges run before cancelled introductions resume");
  assert.equal(transport.calls.slice(3).flatMap(({ blocks }) => blocks).length, 2);
  assert.ok(transport.calls.slice(3).every(({ blocks }) => blocks.every(({ text }) => text.startsWith("Introduction"))));
  assert.equal(translator.getState().completed, 4);
  translator.handle("restore");
});

test("scroll direction uses source range movement for backward prefetch before background fill", async () => {
  const dom = pageDom(`<main>${Array.from({ length: 5 }, (_, index) => `<p id="p${index}">Paragraph ${index}.</p>`).join("")}</main>`);
  Object.defineProperty(dom.window, "innerHeight", { value: 800 });
  let offset = 1_600;
  geometry(dom, (node) => Number(node.parentElement!.id.slice(1)) * 600 - offset);
  const transport = new Transport();
  const gates = [deferred<Result<Translation[]>>(), deferred<Result<Translation[]>>()];
  transport.responder = async (blocks) => gates[transport.calls.length - 1]?.promise
    ?? { ok: true, result: blocks.map(({ id }) => ({ id, text: "向上预取" })) };
  const translator = new PageTranslator(dom.window.document, transport);
  translator.handle("start", "range-direction", "settings");
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls.some(({ blocks }) => blocks.some(({ text }) => text === "Paragraph 0.")), false);
  offset = 800;
  dom.window.document.dispatchEvent(new dom.window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  gates[1].resolve({ ok: true, result: transport.calls[1].blocks.map(({ id }) => ({ id, text: "当前段落完成" })) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(transport.calls[2].blocks.map(({ text }) => text), ["Paragraph 0.", "Paragraph 1."],
    "upward prefetch reaches one screen above while another reading request is still active; far fill cannot run yet");
  assert.equal(transport.calls[0].options?.signal?.aborted, false);
  gates[0].resolve({ ok: true, result: transport.calls[0].blocks.map(({ id }) => ({ id, text: "原请求完成" })) });
  await translator.whenIdle();
  assert.equal(translator.getState().completed, 5);
});
