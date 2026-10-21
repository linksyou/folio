import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { Result, TextBlock, Translation } from "../src/shared/protocol.js";
import {
  PageTranslator,
  type TranslationOptions,
  type TranslationTransport,
} from "../src/extension/page/PageTranslator.js";

const paragraph = "A long source paragraph that streams while the reader moves. ".repeat(15).trim();
const rectangle = (top: number, height = 80): DOMRect => ({
  top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top,
  toJSON() {},
});

function fixture(html: string) {
  const dom = new JSDOM(html, { url: "https://example.com/streaming-preview", pretendToBeVisual: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 800 });
  const positions = new Map<string, DOMRect>();
  const createRange = dom.window.document.createRange.bind(dom.window.document);
  dom.window.document.createRange = () => {
    const range = createRange();
    range.getClientRects = () => {
      const node = range.startContainer.childNodes[range.startOffset] ?? range.startContainer;
      const element = node.nodeType === node.ELEMENT_NODE ? node as Element : node.parentElement;
      const rect = positions.get(element?.closest("[id]")?.id ?? "");
      return (rect ? [rect] : []) as unknown as DOMRectList;
    };
    return range;
  };
  const calls: Array<{ blocks: TextBlock[]; options?: TranslationOptions }> = [];
  const transport: TranslationTransport = {
    async translate(_jobId, _settingsRevision, blocks, options): Promise<Result<Translation[]>> {
      calls.push({ blocks, options });
      return new Promise(() => undefined);
    },
    async cancel() {},
  };
  const translator = new PageTranslator(dom.window.document, transport);
  const scroll = async () => {
    dom.window.document.dispatchEvent(new dom.window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 60));
  };
  return { dom, positions, calls, translator, scroll };
}

test("a visible streaming translation keeps its request alive after the source leaves the window", async () => {
  const { dom, positions, calls, translator, scroll } = fixture(`<main><p id="source">${paragraph}</p><p id="new">New content beside the preview.</p></main>`);
  positions.set("source", rectangle(20));
  positions.set("new", rectangle(4_000));
  translator.handle("start", "visible-preview", "settings");
  assert.equal(calls.length, 1);
  const call = calls[0];
  call.options?.onProgress?.([{ id: call.blocks[0].id, text: "读者仍在阅读的流式译文" }]);
  const output = dom.window.document.querySelector<HTMLElement>("[data-open-web-translator]")!;
  output.getBoundingClientRect = () => rectangle(100, 200);
  positions.set("source", rectangle(-2_000));
  positions.set("new", rectangle(400));
  await scroll();
  assert.equal(call.options?.signal?.aborted, false);
  assert.equal(calls[1].blocks[0].text, "New content beside the preview.",
    "new visible demand uses the free slot without cancelling the preview still being read");
  assert.equal(output.isConnected, true);
  assert.equal(translator.getDiagnostics().some((event) => event.stage === "batch.cancelDistant"), false);
  translator.handle("restore");
  await translator.whenIdle();
});

test("a distant streaming source and preview yield to newly visible unrequested text", async () => {
  const { dom, positions, calls, translator, scroll } = fixture(`<main><p id="source">${paragraph}</p><p id="new">New reading position.</p></main>`);
  positions.set("source", rectangle(20));
  positions.set("new", rectangle(4_000));
  translator.handle("start", "distant-preview", "settings");
  const call = calls[0];
  call.options?.onProgress?.([{ id: call.blocks[0].id, text: "离开视口后的流式译文" }]);
  const output = dom.window.document.querySelector<HTMLElement>("[data-open-web-translator]")!;
  output.getBoundingClientRect = () => rectangle(-1_800, 200);
  positions.set("source", rectangle(-2_000));
  positions.set("new", rectangle(100));
  await scroll();
  assert.equal(call.options?.signal?.aborted, true);
  assert.equal(calls[1].blocks[0].text, "New reading position.");
  assert.equal(output.isConnected, false);
  assert.equal(translator.getDiagnostics().filter((event) => event.stage === "batch.cancelDistant").length, 1);
  translator.handle("restore");
  await translator.whenIdle();
});

test("a visible nested list does not keep a distant parent introduction and its preview alive", async () => {
  const { dom, positions, calls, translator, scroll } = fixture(`<main><ul><li id="parent">${paragraph}
    <ul><li id="child">${paragraph}</li></ul></li></ul><p id="new">A newly visible paragraph.</p></main>`);
  positions.set("parent", rectangle(20));
  positions.set("child", rectangle(1_000));
  positions.set("new", rectangle(4_000));
  dom.window.document.querySelector<HTMLElement>("#parent")!.getBoundingClientRect = () => rectangle(-2_000, 2_800);
  translator.handle("start", "nested-preview", "settings");
  assert.equal(calls.length, 2);
  const parentCall = calls[0];
  const childCall = calls[1];
  parentCall.options?.onProgress?.([{ id: parentCall.blocks[0].id, text: "父项流式译文" }]);
  const output = dom.window.document.querySelector<HTMLElement>("#parent > [data-open-web-translator]")!;
  output.getBoundingClientRect = () => rectangle(-1_800, 200);
  positions.set("parent", rectangle(-2_000));
  positions.set("child", rectangle(100));
  positions.set("new", rectangle(300));
  await scroll();
  assert.equal(parentCall.options?.signal?.aborted, true);
  assert.equal(childCall.options?.signal?.aborted, false);
  assert.equal(calls[2].blocks[0].text, "A newly visible paragraph.", "the released slot serves the new screen demand");
  assert.equal(output.isConnected, false);
  translator.handle("restore");
  await translator.whenIdle();
});

test("a distant streaming preview remains useful when the new screen has no unrequested text", async () => {
  const { dom, positions, calls, translator, scroll } = fixture(`<main><p id="source">${paragraph}</p></main>`);
  positions.set("source", rectangle(20));
  translator.handle("start", "no-new-reading-demand", "settings");
  const call = calls[0];
  call.options?.onProgress?.([{ id: call.blocks[0].id, text: "后台继续的流式译文" }]);
  const output = dom.window.document.querySelector<HTMLElement>("[data-open-web-translator]")!;
  output.getBoundingClientRect = () => rectangle(-1_800, 200);
  positions.set("source", rectangle(-2_000));
  await scroll();
  assert.equal(call.options?.signal?.aborted, false, "distance alone does not discard useful remaining-page work");
  assert.equal(output.isConnected, true);
  assert.equal(calls.length, 1);
  assert.equal(translator.getDiagnostics().some(({ stage }) => stage === "batch.cancelDistant"), false);
  translator.handle("restore");
  await translator.whenIdle();
});
