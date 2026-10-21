import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

// Production DOM pipeline in an isolated, network-disabled Chromium. The mock
// transport controls streaming so placement is checked before and after commit.
const output = path.resolve("test-results/placement");
await mkdir(output, { recursive: true });
await rm(path.join(output, "result.json"), { force: true });
const fixture = await readFile("tests/fixtures/placement.html", "utf8");
const compiled = await build({
  stdin: {
    contents: `import { PageTranslator } from './src/extension/page/PageTranslator.ts';
import { translationStyleCss, DEFAULT_TRANSLATION_STYLE } from './src/extension/translation-style.ts';
Object.assign(window, { PageTranslator, translationStyleCss, DEFAULT_TRANSLATION_STYLE });`,
    resolveDir: process.cwd(), sourcefile: "placement-runtime.ts", loader: "ts",
  }, bundle: true, platform: "browser", format: "iife", write: false,
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 2600 }, deviceScaleFactor: 1 });
  await page.route("**/*", (route) => route.abort());
  await page.setContent(fixture);
  await page.addScriptTag({ content: "window.__name = (value) => value;" });
  await page.addScriptTag({ content: compiled.outputFiles[0]!.text });
  await page.evaluate(() => {
    const runtime = window as any;
    const main = document.querySelector("main")!;
    runtime.originalHtml = main.innerHTML;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_ALL);
    runtime.originalNodes = [];
    while (walker.nextNode()) runtime.originalNodes.push(walker.currentNode);
    runtime.link = document.querySelector("#original-link");
    runtime.linkClicks = 0;
    runtime.link.addEventListener("click", (event: Event) => { event.preventDefault(); runtime.linkClicks++; });
    const style = document.createElement("style");
    style.textContent = runtime.translationStyleCss(runtime.DEFAULT_TRANSLATION_STYLE);
    document.head.append(style);
    runtime.requests = [];
    runtime.pending = [];
    runtime.observedPreviews = new Map();
    runtime.hold = true;
    runtime.translator = new runtime.PageTranslator(document, {
      translate: async (_job: string, _revision: string, blocks: Array<{ id: string; text: string }>, options: any) => {
        runtime.requests.push(blocks.map((block) => block.text));
        options?.onProgress?.(blocks.map(({ id, text }) => ({ id, text: `预览：${text}` })));
        for (const node of document.querySelectorAll('[data-open-web-translator="translation"][aria-busy="true"]')) {
          if (!runtime.observedPreviews.has(node)) {
            runtime.observedPreviews.set(node, { parent: node.parentNode, anchor: node.previousSibling });
          }
        }
        if (runtime.hold) await new Promise<void>((resolve) => runtime.pending.push(resolve));
        return { ok: true, result: blocks.map(({ id, text }) => ({ id, text: `译文：${text}` })) };
      }, cancel: async () => {},
    }, { getUrl: () => "https://fixture.invalid/placement" });
    runtime.translator.handle("start", "placement-job", "placement-settings");
  });

  await page.locator('[data-open-web-translator="translation"][aria-busy="true"]').first().waitFor();
  const preview = await page.evaluate(() => {
    const runtime = window as any;
    runtime.previews = Array.from(document.querySelectorAll('[data-open-web-translator="translation"]'));
    return runtime.previews.map((node: HTMLElement) => ({
      tag: node.tagName, parent: node.parentElement?.id,
      anchorIsSource: !!node.previousSibling && !((node.previousSibling as Element).hasAttribute?.("data-open-web-translator")),
    }));
  });
  assert(preview.length > 0);
  for (const item of preview) {
    assert.equal(item.tag, "SPAN");
    assert(item.parent, "streaming output stays inside its source container");
    assert(item.anchorIsSource, "streaming output follows the source node range");
  }
  await page.screenshot({ path: path.join(output, "streaming.png"), fullPage: true });
  await page.evaluate(async () => {
    const runtime = window as any;
    runtime.hold = false;
    for (const resolve of runtime.pending.splice(0)) resolve();
    await runtime.translator.whenIdle();
  });

  const result = await page.evaluate(() => {
    const runtime = window as any;
    const generated = '[data-open-web-translator="translation"]';
    const children = (selector: string) => Array.from(document.querySelector(selector)!.childNodes).map((node) => ({
      type: node.nodeType, id: (node as Element).id ?? "", text: node.textContent,
      translation: (node as Element).matches?.(generated) ?? false,
    }));
    const cells = Array.from(document.querySelectorAll("#metadata-table th, #metadata-table td")).map((cell) => ({
      id: cell.id, output: cell.querySelector(`:scope > ${generated}`)?.textContent,
    }));
    const layouts = ["flex", "grid"].map((id) => {
      const container = document.getElementById(id)!;
      const items = Array.from(container.children);
      return { id, children: items.map((item) => item.id), items: items.map((item) => {
        const source = item.getBoundingClientRect();
        const translation = item.querySelector(generated)!.getBoundingClientRect();
        return {
          source: { x: source.x, y: source.y, right: source.right, bottom: source.bottom },
          translation: { x: translation.x, y: translation.y, right: translation.right, bottom: translation.bottom },
        };
      }) };
    });
    return {
      state: runtime.translator.getState(), requests: runtime.requests,
      previewsReused: runtime.previews.every((node: HTMLElement) => node.isConnected && !node.hasAttribute("aria-busy")),
      allStreamingAnchors: Array.from(runtime.observedPreviews, ([node, initial]: any) => ({
        parent: node.parentElement?.id, sameNodeAndAnchor: node.isConnected && !node.hasAttribute("aria-busy")
          && node.parentNode === initial.parent && node.previousSibling === initial.anchor,
      })),
      residual: children("#residual"), parentItem: children("#parent-item"), cells, layouts,
      orphanTranslations: Array.from(document.querySelectorAll(generated)).filter((node) => !node.parentElement?.id).length,
      tableWrapperOutputs: document.querySelectorAll(`#table-wrapper > ${generated}`).length,
    };
  });
  assert.equal(result.state.failed, 0);
  assert.equal(result.state.completed, 16);
  assert(result.previewsReused, "streaming and committed output reuse the same DOM nodes");
  assert.equal(result.allStreamingAnchors.length, 16);
  assert(result.allStreamingAnchors.every((item) => item.sameNodeAndAnchor),
    "every list, cell and layout range keeps its streaming node and original anchor at completion");
  assert.equal(result.orphanTranslations, 0);
  assert.equal(result.tableWrapperOutputs, 0, "table contents cannot become one outer-container translation");
  assert.deepEqual(result.residual.map((node: any) => node.translation ? "translation" : node.id || "text"), ["text", "translation", "inner-paragraph", "text", "translation"]);
  assert.equal(result.residual[1].text, "译文：Container introduction before child paragraph.");
  assert.equal(result.residual[4].text, "译文：Container conclusion after child paragraph.");
  assert.deepEqual(result.parentItem.map((node: any) => node.translation ? "translation" : node.id || "text"), ["text", "translation", "child-list", "text", "translation"]);
  assert.equal(result.parentItem[1].text, "译文：Parent list introduction before its child list.");
  assert.equal(result.parentItem[4].text, "译文：Parent list conclusion after its child list.");
  assert.deepEqual(result.cells.map((cell: any) => cell.output), [
    "译文：Name", "译文：Example application", "译文：Description", "译文：Public sample description",
  ]);
  for (const layout of result.layouts) {
    assert.deepEqual(layout.children, [`${layout.id}-title`, `${layout.id}-body`]);
    assert(Math.abs(layout.items[0].source.y - layout.items[1].source.y) < 1, "original columns keep the same row");
    for (const item of layout.items) {
      assert(item.translation.x >= item.source.x - 1 && item.translation.right <= item.source.right + 1);
      assert(item.translation.y >= item.source.y && item.translation.bottom <= item.source.bottom + 1);
    }
  }
  await page.screenshot({ path: path.join(output, "completed.png"), fullPage: true });
  await page.locator("#original-link").click();
  const restored = await page.evaluate(async () => {
    const runtime = window as any;
    runtime.translator.handle("restore");
    await runtime.translator.whenIdle();
    const main = document.querySelector("main")!;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_ALL);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return {
      htmlMatches: main.innerHTML === runtime.originalHtml,
      nodesMatch: nodes.length === runtime.originalNodes.length && nodes.every((node, index) => node === runtime.originalNodes[index]),
      linkMatches: document.querySelector("#original-link") === runtime.link,
      linkClicks: runtime.linkClicks,
      translations: document.querySelectorAll('[data-open-web-translator="translation"]').length,
    };
  });
  assert(restored.htmlMatches);
  assert(restored.nodesMatch, "restore preserves every original element and text node identity");
  assert(restored.linkMatches);
  assert.equal(restored.linkClicks, 1);
  assert.equal(restored.translations, 0);

  // Existing ranges must remain independently addressable when source text changes
  // and new content is inserted after a completed translation.
  await page.evaluate(async () => {
    const runtime = window as any;
    runtime.translator.handle("start", "placement-dynamic-job", "placement-settings");
    await runtime.translator.whenIdle();
    document.querySelector("#parent-item")!.firstChild!.textContent = "Updated parent introduction before its child list.";
    const added = document.createElement("p");
    added.id = "dynamic-paragraph";
    added.textContent = "Dynamically added independent paragraph.";
    document.querySelector("#residual")!.append(added);
  });
  await page.waitForFunction(() => {
    const output = document.querySelector('#dynamic-paragraph > [data-open-web-translator="translation"]');
    const parent = document.querySelector('#parent-item > [data-open-web-translator="translation"]');
    return output?.textContent === "译文：Dynamically added independent paragraph."
      && parent?.textContent === "译文：Updated parent introduction before its child list.";
  });
  const dynamic = await page.evaluate(async () => {
    const runtime = window as any;
    await runtime.translator.whenIdle();
    const parent = document.querySelector("#parent-item")!;
    const firstOutput = parent.querySelector('[data-open-web-translator="translation"]')!;
    const snapshot = {
      parentOutputBeforeChild: firstOutput.nextSibling === document.querySelector("#child-list"),
      parentOutputs: parent.querySelectorAll(':scope > [data-open-web-translator="translation"]').length,
      addedOutputs: document.querySelectorAll('#dynamic-paragraph > [data-open-web-translator="translation"]').length,
      sourceRequests: runtime.requests.flat().filter((text: string) => text === "Dynamically added independent paragraph.").length,
    };
    runtime.translator.handle("restore");
    await runtime.translator.whenIdle();
    return { ...snapshot, updatedSource: parent.firstChild?.textContent, addedSource: document.querySelector("#dynamic-paragraph")?.textContent };
  });
  assert(dynamic.parentOutputBeforeChild);
  assert.equal(dynamic.parentOutputs, 2);
  assert.equal(dynamic.addedOutputs, 1);
  assert.equal(dynamic.sourceRequests, 1);
  assert.equal(dynamic.updatedSource, "Updated parent introduction before its child list.");
  assert.equal(dynamic.addedSource, "Dynamically added independent paragraph.");
  await writeFile(path.join(output, "result.json"), JSON.stringify({
    success: true, scope: "Synthetic fixture, production PageTranslator, local mock transport; no remote model requests.",
    browser: browser.version(), preview, result, restored, dynamic,
  }, null, 2));
  console.log("PASS 连续节点范围、嵌套列表、表格单元格、Flex/Grid布局、流式锚点复用、动态正文与原节点恢复");
  console.log(JSON.stringify({ browser: browser.version(), translated: result.state.completed, requests: result.requests.length, output }, null, 2));
} finally {
  await browser.close();
}
