import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { installHost } from "../scripts/install-host.js";
import { EXTENSION_ID } from "../src/shared/extension-identity.js";
import type { PageAction, Result, PageState } from "../src/shared/protocol.js";

// Isolated browser, actual extension/stdio host, deterministic local provider.
// Only the test copy receives localhost host access in place of clicking Chrome's toolbar.
const root = await mkdtemp(path.join(tmpdir(), "open-web-translator-browser-"));
const profile = path.join(root, "profile");
const extension = path.join(root, "extension");
const output = path.resolve("test-results");
await mkdir(output, { recursive: true });
await rm(path.join(output, "browser-result.json"), { force: true });
await cp("dist/extension", extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://127.0.0.1/*"];
await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
await installHost({
  projectRoot: process.cwd(), installRoot: path.join(root, "host-install"),
  manifestDir: path.join(profile, "NativeMessagingHosts"),
});

let calls = 0;
let failNext = false;
let delay = 30;
let holdViewportBatch = false;
let releaseViewportBatch: (() => void) | undefined;
let holdStreams = false;
let cancelledStreams = 0;
let preparationCalls = 0;
let releasePreparation: (() => void) | undefined;
const preparedSockets = new Set<Socket>();
const modelSockets: Socket[] = [];
const streamReleases = new Set<() => void>();
const distantReleases = new Set<() => void>();
let holdDistantRequests = false;
let activeModelRequests = 0;
let activeDistantRequests = 0;
let recordContinuationConcurrency = false;
let continuationMaxConcurrency = 0;
let continuationMaxDistantConcurrency = 0;
const received: string[] = [];
const instructions: string[] = [];
const dynamicFixture = await readFile("tests/fixtures/dynamic-article.html", "utf8");
const compactFixture = `<main>${Array.from({ length: 8 }, (_, i) => `<p>Short visible paragraph ${i + 1}.</p>`).join("")}</main>`;
const languageFixture = `<html lang="zh-CN"><main><p id="already-chinese">这是一段中文内容，我们可以在这里阅读文章。</p><p id="needs-translation">This English paragraph still needs translation despite the Chinese page language.</p></main></html>`;
const requestSizes: number[] = [];
const fixture = await readFile("tests/fixtures/article.html", "utf8");
const longFixture = `<style>
  body { max-width: 680px; margin: 40px auto; font: 18px/1.7 system-ui; }
  article p { min-height: 160px; }
</style><main><article><header><h1>Article header title</h1></header>${
  Array.from({ length: 20 }, (_, i) => `<p id="paragraph-${i + 1}">Viewport paragraph ${i + 1}.</p>`).join("")
}</article></main>`;
const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    preparationCalls++;
    preparedSockets.add(request.socket);
    assert.equal(request.url, "/");
    assert.equal(request.headers.authorization, undefined);
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(body, "");
    if (preparationCalls === 1) await new Promise<void>((resolve) => { releasePreparation = resolve; });
    response.writeHead(405).end();
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === "/dynamic-article" || pathname === "/compact-article" || pathname === "/mixed-language") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(pathname === "/dynamic-article" ? dynamicFixture : pathname === "/mixed-language" ? languageFixture : compactFixture);
    return;
  }
  if (request.url === "/article" || request.url === "/long-article") {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/article" ? fixture : longFixture);
    return;
  }
  if (request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
  modelSockets.push(request.socket);
  calls++;
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  instructions.push(input.messages[0].content);
  const source = input.messages.at(-1).content as string;
  let batch: Array<{ id: string; text: string }> | undefined;
  try { const parsed = JSON.parse(source); if (Array.isArray(parsed)) batch = parsed; } catch {}
  const blocks = batch ?? [{ id: "single", text: source }];
  const distant = blocks.every(({ text }) => /^Viewport paragraph (1\d|20)\.$/.test(text));
  activeModelRequests++;
  if (distant) activeDistantRequests++;
  if (recordContinuationConcurrency) {
    continuationMaxConcurrency = Math.max(continuationMaxConcurrency, activeModelRequests);
    continuationMaxDistantConcurrency = Math.max(continuationMaxDistantConcurrency, activeDistantRequests);
  }
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    activeModelRequests--;
    if (distant) activeDistantRequests--;
  };
  response.once("finish", settle);
  response.once("close", settle);
  requestSizes.push(blocks.length);
  received.push(...blocks.map((block) => block.text));
  const fail = failNext;
  failNext = false;
  if (holdViewportBatch && blocks.some((block) => block.text === "Viewport paragraph 1.")) {
    holdViewportBatch = false;
    await new Promise<void>((resolve) => { releaseViewportBatch = resolve; });
  }
  if (holdDistantRequests && distant) {
    await new Promise<void>((resolve) => {
      const release = () => { distantReleases.delete(release); resolve(); };
      distantReleases.add(release);
      response.once("close", release);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (response.destroyed) return;
  if (fail) { response.writeHead(500).end("{}"); return; }
  const translations = blocks.map(({ id, text }) => ({
    id, text: text.startsWith("Welcome") ? "欢迎来到你的双语阅读空间。" : `中文译文：${text}`,
  }));
  if (input.stream) {
    response.setHeader("content-type", "text/event-stream");
    const send = (content: string, finish: string | null = null) => response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`,
    );
    const text = batch ? JSON.stringify(translations) : translations[0].text;
    const split = batch ? Math.max(4, text.length - 5) : 4;
    send(text.slice(0, split));
    if (holdStreams) {
      await new Promise<void>((resolve) => {
        const release = () => { streamReleases.delete(release); resolve(); };
        streamReleases.add(release);
        response.once("close", () => {
          if (!response.writableEnded) cancelledStreams++;
          release();
        });
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (response.destroyed) return;
    send(text.slice(split), "stop");
    response.end("data: [DONE]\n\n");
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    choices: [{ finish_reason: "stop", message: {
      content: JSON.stringify(translations),
    } }],
  }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;

// Playwright normally forces focus emulation on every tab, so inactive pages
// still report visible. Attach without those overrides to an isolated browser:
// real tab switching must drive the page's visibilitychange and continuation.
const browserProcess = spawn(chromium.executablePath(), [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  // Match Playwright's CI defaults inside this disposable local-test browser.
  ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
  "--no-first-run", "--no-default-browser-check", "--window-size=1100,850",
  `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const browserExited = new Promise<void>((resolve) => browserProcess.once("close", () => resolve()));
let browser: Browser | undefined;
try {
  const endpoint = await new Promise<string>((resolve, reject) => {
    let startupLog = "";
    const timer = setTimeout(() => finish(new Error("Isolated Chromium did not expose its debugging endpoint")), 15_000);
    const onData = (chunk: Buffer) => {
      startupLog = (startupLog + String(chunk)).slice(-8_192);
      const match = startupLog.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) finish(undefined, match[1]);
    };
    const onError = () => finish(new Error("Isolated Chromium could not start"));
    const onClose = () => finish(new Error("Isolated Chromium exited during startup"));
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      browserProcess.stderr.off("data", onData);
      browserProcess.off("error", onError);
      browserProcess.off("close", onClose);
      if (error) reject(error); else resolve(value!);
    };
    browserProcess.stderr.on("data", onData);
    browserProcess.once("error", onError);
    browserProcess.once("close", onClose);
  });
  browserProcess.stderr.resume();
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 15_000 });
  const context = browser.contexts()[0];
  const options = await context.newPage();
  // Keep only the setup UI responsive to background clicks. The article page
  // receives no focus override, so its hidden/visible states remain genuine.
  const optionsSession = await context.newCDPSession(options);
  await optionsSession.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await options.setViewportSize({ width: 1100, height: 850 });
  await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  await options.waitForFunction(() => {
    const text = document.querySelector("#auth-summary")?.textContent;
    return text && !text.includes("读取");
  }, { timeout: 15_000 });
  assert.equal(await options.locator("#host-error").isVisible(), false,
    await options.locator("#host-error").textContent() ?? "Host connection failed");
  await options.locator('input[value="custom"]').check();
  await options.locator("#custom-base-url").fill(`${base}/v1`);
  await options.locator("#custom-model").fill("local-test");
  await options.locator("#test").click();
  await options.locator("#notice").filter({ hasText: "连接正常" }).waitFor({ timeout: 15_000 });
  await options.screenshot({ path: path.join(output, "settings.png"), fullPage: true });
  console.log("PASS 设置页 → Native Messaging → 本地程序 → 自定义 API");

  const page = await context.newPage();
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto(`${base}/article`);
  const originalArticle = await page.locator("article").innerHTML();
  await page.evaluate(() => {
    (window as any).originalSourceLink = document.querySelector("#linked a");
  });
  await page.bringToFront();
  const action = async (value: PageAction): Promise<PageState> => {
    const result = await options.evaluate(async (action) =>
      chrome.runtime.sendMessage({ type: "page.action", action }), value) as Result<PageState>;
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.result;
  };
  const untilDone = async () => {
    for (let i = 0; i < 200; i++) {
      const state = await action("status");
      if (state.status !== "running" && state.status !== "watching") return state;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Translation did not finish");
  };
  // Close the settings test's idle socket to reproduce a cold popup opening.
  server.closeIdleConnections();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const beforePreparation = calls;
  const modelSocketsBeforePreparation = modelSockets.length;
  const preparationPopup = await context.newPage();
  await preparationPopup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await page.bringToFront();
  for (let i = 0; (!releasePreparation || preparationCalls < 2) && i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(releasePreparation, "opening the popup must prepare the selected server");
  assert.equal(preparationCalls, 2, "cold preparation warms both request slots");
  assert.equal(preparedSockets.size, 2, "the two probes establish separate pooled sockets");
  assert.equal(calls, beforePreparation, "preparation must not generate text");
  // Slow-probe takeover is tested with a bounded foreground budget in the
  // transport tests. Here wait for readiness, so browser/IPC scheduling cannot
  // accidentally exceed that budget before this test releases the probe.
  releasePreparation();
  await preparationPopup.locator("#connection-preparation").filter({ hasText: "已就绪" }).waitFor();
  assert.equal(calls, beforePreparation, "both completed probes still generate no model text");
  await page.bringToFront();
  await preparationPopup.evaluate(() => document.querySelector<HTMLButtonElement>("#start")!.click());
  await page.locator('[data-open-web-translator="translation"]').first().waitFor({ timeout: 15_000 });
  const translated = await untilDone();
  const firstModelSockets = modelSockets.slice(modelSocketsBeforePreparation, modelSocketsBeforePreparation + 2);
  assert(firstModelSockets.length > 0, "the popup click starts at least one model request");
  assert(firstModelSockets.every((socket) => preparedSockets.has(socket)), "the first model requests reuse the prepared sockets");
  assert.equal(preparationCalls, 2, "starting translation does not launch duplicate probes");
  await preparationPopup.close();
  const clickedTrace = await options.evaluate(() => chrome.runtime.sendMessage({ type: "diagnostics.get" }));
  assert.equal(clickedTrace.ok, true);
  const clickTiming = clickedTrace.result.page.find((event: any) => event.stage === "ui.firstVisible");
  assert(clickTiming && clickTiming.values.clickToVisibleMs >= 0, "popup click is measured through the first visible DOM translation");
  await writeFile(path.join(output, "click-performance-trace.json"), JSON.stringify(clickedTrace.result, null, 2));
  console.log("PASS 打开弹窗预热两个连接、不生成文本、就绪后点击复用准备连接");
  assert(translated.completed > 0);
  assert.equal(translated.failed, 0);
  assert.equal(await page.locator("a[href='https://example.com/source']").count(), 1);
  assert(!received.some((text) => text.includes("hidden paragraph") || text.includes("Site navigation")));
  await page.screenshot({ path: path.join(output, "bilingual-page.png"), fullPage: true });
  const styleCalls = calls;
  const styleSource = await page.locator("#linked").innerHTML();
  const originalStyle = await page.locator("#linked").getAttribute("style");
  const originalFont = await page.locator("#linked > [data-open-web-translator=translation]").evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  assert.deepEqual(await page.locator("#linked > [data-open-web-translator=translation]").evaluate((node) => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor, border: style.borderInlineStartWidth, decoration: style.textDecorationLine };
  }), { color: "rgb(74, 152, 52)", background: "rgba(0, 0, 0, 0)", border: "0px", decoration: "none" });
  const styleRevision = await options.evaluate(async () =>
    (await chrome.runtime.sendMessage({ type: "host.request", command: { type: "status" } })).result.settingsRevision);
  await options.locator("#translation-style-preset").selectOption("background");
  await options.locator("#translation-font-scale").selectOption("1.25");
  await page.waitForFunction((font) => {
    const node = document.querySelector("#linked > [data-open-web-translator=translation]");
    if (!node) return false;
    const style = getComputedStyle(node);
    return style.backgroundColor === "rgb(238, 247, 241)" && Math.abs(parseFloat(style.fontSize) - font * 1.25) < .1;
  }, originalFont);
  await page.screenshot({ path: path.join(output, "translation-background-style.png"), fullPage: true });
  await options.reload();
  await options.waitForFunction(() => document.querySelector<HTMLSelectElement>("#translation-style-preset")?.value === "background"
    && document.querySelector<HTMLSelectElement>("#translation-font-scale")?.value === "1.25");
  await options.locator("#translation-style-preset").selectOption("underline");
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#linked > [data-open-web-translator=translation]")!).textDecorationLine === "underline");
  await options.locator("#translation-style-preset").selectOption("plain");
  await page.waitForFunction(() => {
    const style = getComputedStyle(document.querySelector("#linked > [data-open-web-translator=translation]")!);
    return style.textDecorationLine === "none" && style.borderInlineStartWidth === "0px" && style.backgroundColor === "rgba(0, 0, 0, 0)";
  });
  // input (before the picker closes) must update preview and an existing page.
  for (const [id, color] of [["translation-text-color", "#b91c1c"], ["translation-background-color", "#fff4cc"]]) {
    await options.locator(`#${id}`).evaluate((element, color) => {
      (element as HTMLInputElement).value = color;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, color);
  }
  const waitCustomColors = () => page.waitForFunction(() => {
    const style = getComputedStyle(document.querySelector("#linked > [data-open-web-translator=translation]")!);
    return style.color === "rgb(185, 28, 28)" && style.backgroundColor === "rgb(255, 244, 204)";
  });
  await waitCustomColors();
  await options.waitForFunction(() => {
    const style = getComputedStyle(document.querySelector("#translation-style-preview")!);
    return style.color === "rgb(185, 28, 28)" && style.backgroundColor === "rgb(255, 244, 204)";
  });
  await page.screenshot({ path: path.join(output, "translation-custom-colors.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await waitCustomColors();
  await options.reload();
  await options.waitForFunction(() => document.querySelector<HTMLInputElement>("#translation-text-color")?.value === "#b91c1c"
    && document.querySelector<HTMLInputElement>("#translation-background-color")?.value === "#fff4cc");
  await options.locator("#translation-text-color-reset").click();
  await page.waitForFunction(() => {
    const node = document.querySelector("#linked > [data-open-web-translator=translation]")!;
    return getComputedStyle(node).color === "rgb(74, 152, 52)"
      && getComputedStyle(node).backgroundColor === "rgb(255, 244, 204)";
  });
  await options.locator("#translation-background-color-reset").click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#linked > [data-open-web-translator=translation]")!).backgroundColor === "rgba(0, 0, 0, 0)");
  assert.equal(await options.locator("#translation-style-preset").inputValue(), "plain");
  assert.equal(await options.locator("#translation-font-scale").inputValue(), "1.25");
  await options.locator("#translation-style-preset").selectOption("background");
  await page.waitForFunction(() => {
    const style = getComputedStyle(document.querySelector("#linked > [data-open-web-translator=translation]")!);
    return style.color === "rgb(74, 152, 52)" && style.backgroundColor === "rgb(36, 59, 48)";
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#linked > [data-open-web-translator=translation]")!).backgroundColor === "rgb(238, 247, 241)");
  await options.locator("#translation-style-reset").click();
  await page.waitForFunction((font) => {
    const style = getComputedStyle(document.querySelector("#linked > [data-open-web-translator=translation]")!);
    return style.borderInlineStartWidth === "0px" && style.textDecorationLine === "none"
      && style.color === "rgb(74, 152, 52)" && style.backgroundColor === "rgba(0, 0, 0, 0)"
      && parseFloat(style.fontSize) === font;
  }, originalFont);
  assert.equal(await page.locator("#linked").innerHTML(), styleSource);
  assert.equal(await page.locator("#linked").getAttribute("style"), originalStyle);
  assert.equal(await options.evaluate(async () =>
    (await chrome.runtime.sendMessage({ type: "host.request", command: { type: "status" } })).result.settingsRevision), styleRevision);
  assert.equal(calls, styleCalls, "appearance changes never regenerate existing translations");
  await page.bringToFront();
  console.log("PASS 四种译文样式、字号实时应用、设置重开持久化、恢复默认，原文和模型请求不变");
  console.log("PASS 自定义文字/背景颜色input即时应用、跨主题保留、分别恢复默认配色与持久化");
  const previousCalls = calls;
  const floating = page.locator('[data-open-web-translator-ui="floating"]');
  await floating.waitFor();
  await options.locator("#floating-enabled").uncheck();
  await floating.waitFor({ state: "hidden" });
  await options.locator("#floating-enabled").check();
  await floating.waitFor({ state: "visible" });
  await page.bringToFront();
  assert.equal(await floating.locator("button").count(), 1);
  await page.waitForFunction(() => {
    const icon = document.querySelector('[data-open-web-translator-ui]')?.shadowRoot?.querySelector("img");
    return icon?.complete && icon.naturalWidth === 32;
  });
  await floating.locator(".trigger").click();
  await page.waitForFunction(() => !document.querySelector('[data-open-web-translator="translation"]'));
  assert.equal(await page.locator('[data-open-web-translator="translation"]').count(), 0);
  assert.equal(await page.locator("article").innerHTML(), originalArticle);
  assert.equal(await page.evaluate(() => document.querySelector("#linked a") === (window as any).originalSourceLink), true);
  assert.equal(await floating.isVisible(), true, "restore preserves floating entry");
  await floating.locator(".trigger").click();
  assert.equal((await untilDone()).completed, translated.completed);
  await page.waitForFunction(() => document.querySelector('[data-open-web-translator-ui]')?.shadowRoot?.querySelector(".trigger")?.getAttribute("data-status") === "completed");
  assert.equal(calls, previousCalls, "Restore then start reuses page cache");
  console.log("PASS 正文双语、原链接、恢复原文和本页缓存");
  console.log("PASS 真实扩展悬浮入口：原书页图标加载、单击恢复/翻译、即时开关与缓存复用，新增模型请求 0");

  const beforeRefresh = calls;
  await page.reload();
  await action("start");
  const cachedPage = await untilDone();
  assert.equal(cachedPage.completed, translated.completed);
  assert.equal(calls, beforeRefresh, "refresh creates new source nodes but reuses persistent results");
  const persisted = await options.evaluate(() => new Promise<any[]>((resolve, reject) => {
    const open = indexedDB.open("open-web-translator-translations", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("translations", "readonly").objectStore("translations").getAll();
      request.onsuccess = () => { resolve(request.result); db.close(); };
      request.onerror = () => { reject(request.error); db.close(); };
    };
  }));
  assert.equal(persisted.length, translated.completed, "completed results are stored in real extension IndexedDB");
  assert(persisted.every((entry) => !Object.hasOwn(entry, "source") && !Object.hasOwn(entry, "url") && /^[a-f0-9]{64}$/.test(entry.key)));
  const cacheTrace = await options.evaluate(() => chrome.runtime.sendMessage({ type: "diagnostics.get" }));
  assert(cacheTrace.result.background.some((event: any) => event.stage === "reuse.end" && event.values.success && event.values.providerGroups === 0));
  await writeFile(path.join(output, "cache-performance-trace.json"), JSON.stringify(cacheTrace.result, null, 2));

  const displayCalls = calls;
  const displayRevision = await options.evaluate(async () => (await chrome.runtime.sendMessage({ type: "host.request", command: { type: "status" } })).result.settingsRevision);
  await options.locator("#display-mode").selectOption("translation-only");
  await page.waitForFunction(() => document.querySelector("h1")!.firstChild?.textContent === "");
  await options.locator("#display-mode").selectOption("bilingual");
  await page.waitForFunction(() => document.querySelector("h1")!.firstChild?.textContent === "A useful article");
  assert.equal(calls, displayCalls);
  assert.equal(await options.evaluate(async () => (await chrome.runtime.sendMessage({ type: "host.request", command: { type: "status" } })).result.settingsRevision), displayRevision);

  const beforeDuplicates = calls;
  const beforeDuplicateText = received.length;
  await page.evaluate(() => {
    for (let index = 0; index < 4; index++) {
      const paragraph = document.createElement("p");
      paragraph.className = "duplicate-source";
      paragraph.textContent = "This repeated paragraph needs only one shared translation.";
      document.querySelector("article")!.append(paragraph);
    }
  });
  await page.waitForFunction(() => document.querySelectorAll(".duplicate-source > [data-open-web-translator=translation]:not([aria-busy])").length === 4);
  await untilDone();
  assert.equal(calls - beforeDuplicates, 1, "duplicate source across page batches uses one provider request");
  assert.equal(received.slice(beforeDuplicateText).length, 1, "provider receives the repeated text only once");
  const beforeEdit = calls;
  await page.locator("#inline-code").evaluate((element) => { element.textContent = "Only this edited paragraph should require a new translation."; });
  await page.waitForFunction(() => document.querySelector("#inline-code > [data-open-web-translator=translation]:not([aria-busy])")?.textContent?.includes("Only this edited paragraph"));
  await untilDone();
  assert.equal(calls - beforeEdit, 1);
  const beforeForce = calls;
  await action("retranslate");
  await untilDone();
  assert(calls > beforeForce, "force bypasses the stored results");
  await options.reload();
  await options.locator("#cache-origin").selectOption(base);
  await options.locator("#cache-clear-site").click();
  await options.locator("#cache-status").filter({ hasText: "已清除此网站" }).waitFor();
  assert.equal((await options.evaluate(() => chrome.runtime.sendMessage({ type: "cache.status" }))).result.entries, 0);
  await options.locator("#cache-enabled").uncheck();
  await options.locator("#cache-status").filter({ hasText: "已停用缓存" }).waitFor();
  console.log(`PASS 刷新 ${cachedPage.completed} 段新增 0 请求，4 个重复段合并为 1 请求，改单段仅 1 请求，强制重译绕过缓存，真实 IndexedDB 按站清除`);
  console.log("PASS 双语/仅译文即时切换，无需保存模型设置，新增 0 请求且生成版本不变");

  await page.goto(`${base}/mixed-language`);
  const beforeLanguage = calls;
  const languageTextStart = received.length;
  await action("start");
  const languageState = await untilDone();
  assert.equal(languageState.skipped, 1);
  assert.equal(languageState.completed, 1);
  assert.equal(calls - beforeLanguage, 1);
  assert.equal(received.slice(languageTextStart).length, 1);
  assert(received.at(-1)!.startsWith("This English paragraph"));
  assert.equal(await page.locator("#already-chinese > [data-open-web-translator]").count(), 0);
  await action("retranslate");
  const forcedLanguage = await untilDone();
  assert.equal(forcedLanguage.skipped, 0);
  assert.equal(forcedLanguage.completed, 2);
  await action("restore");
  assert.equal(await page.locator("[data-open-web-translator]").count(), 0);
  console.log("PASS 中文页面混合段落仅发送英文；强制重译可覆盖语言跳过；恢复原文保留所有源段落");

  await page.goto(`${base}/long-article`);
  delay = 300;
  holdViewportBatch = true;
  holdDistantRequests = true;
  recordContinuationConcurrency = true;
  const continuationCallsBefore = calls;
  await action("start");
  await page.locator('[data-open-web-translator="translation"]').first().waitFor();
  assert.equal((await action("status")).status, "running", "A small batch appears before the viewport finishes");
  assert(releaseViewportBatch, "The other batch is deliberately still pending");
  releaseViewportBatch();
  // Once a distant request is held, the current and nearby reading area has
  // finished. The gate makes the tab switch independent of machine speed.
  for (let i = 0; !distantReleases.size && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(distantReleases.size, 1, "idle continuation starts one distant request");
  const firstWindow = await action("status");
  assert(firstWindow.completed > 0 && firstWindow.completed < firstWindow.total);
  assert.equal(await page.locator("article header [data-open-web-translator]").count(), 1);
  assert.equal(await page.locator("#paragraph-20 > [data-open-web-translator=translation]").count(), 0);
  const beforeLeaving = await page.locator('[data-open-web-translator="translation"]:not([aria-busy])').count();
  const readingScrollY = await page.evaluate(() => scrollY);
  const otherTab = await context.newPage();
  await otherTab.goto("about:blank");
  await otherTab.bringToFront();
  await page.waitForFunction(() => document.visibilityState === "hidden");
  holdDistantRequests = false;
  for (const release of distantReleases) release();
  await page.locator("#paragraph-20 > [data-open-web-translator=translation]:not([aria-busy])").waitFor({ timeout: 20_000 });
  const whileAway = await page.locator('[data-open-web-translator="translation"]:not([aria-busy])').count();
  assert(whileAway > beforeLeaving, "the hidden page keeps translating without a scroll");
  const awayVisibility = await page.evaluate(() => document.visibilityState);
  assert.equal(awayVisibility, "hidden");
  await page.bringToFront();
  const continued = await untilDone();
  assert.equal(continued.status, "completed");
  assert.equal(continued.completed, continued.total, "returning shows the completed whole document");
  assert.equal(continued.failed, 0);
  const returnedScrollY = await page.evaluate(() => scrollY);
  assert.equal(returnedScrollY, readingScrollY, "continuation does not move the reading position");
  assert(continuationMaxConcurrency <= 2, "continuation never increases the two model request slots");
  assert.equal(continuationMaxDistantConcurrency, 1, "distant idle work uses only one request slot");
  recordContinuationConcurrency = false;
  const continuationRequests = calls - continuationCallsBefore;
  await page.screenshot({ path: path.join(output, "background-continuation.png"), fullPage: true });
  console.log(`PASS 首屏优先，切换真实标签页后无滚动继续，返回时全页 ${continued.completed} 段已完成，${continuationRequests} 个请求，最大并发 ${continuationMaxConcurrency}/离屏 ${continuationMaxDistantConcurrency}`);

  const beforeRetranslate = calls;
  delay = 20;
  await action("retranslate");
  await untilDone();
  assert(calls > beforeRetranslate, "Retranslation sends a fresh provider request");
  assert.equal((await action("stop")).status, "stopped");
  const beforeStoppedScroll = calls;
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls, beforeStoppedScroll, "Watching can be stopped before scrolling");
  console.log("PASS 标题、分批显示、强制重译和停止监听");

  // Stop while an idle request is still in flight, then leave and return.
  // A visibility change, scroll or late response must not re-enable the job.
  await page.reload();
  holdDistantRequests = true;
  await action("start");
  for (let i = 0; !distantReleases.size && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(distantReleases.size, 1);
  assert.equal((await action("stop")).status, "stopped");
  const afterContinuationStop = calls;
  const stoppedCompleted = await page.locator('[data-open-web-translator="translation"]:not([aria-busy])').count();
  holdDistantRequests = false;
  for (const release of distantReleases) release();
  await otherTab.bringToFront();
  await page.waitForFunction(() => document.visibilityState === "hidden");
  await page.bringToFront();
  await page.locator("#paragraph-20").scrollIntoViewIfNeeded();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(calls, afterContinuationStop, "stopping suppresses idle, visibility and scroll continuation");
  assert.equal(await page.locator('[data-open-web-translator="translation"]:not([aria-busy])').count(), stoppedCompleted);
  assert.equal(await page.locator('[data-open-web-translator="translation"][aria-busy]').count(), 0);
  assert.equal((await action("status")).status, "stopped");
  await otherTab.close();
  console.log("PASS 空闲补全中停止，切走返回和滚动不复活，迟到结果不写回");

  // Keep both provider slots open after the first delta. A distant scroll must
  // cancel those HTTP streams before the new viewport can produce any preview.
  await page.goto(`${base}/long-article`);
  delay = 20;
  holdStreams = true;
  const beforeCancelledStreams = cancelledStreams;
  const startedAt = performance.now();
  await action("start");
  const preview = page.locator('[data-open-web-translator="translation"][aria-busy="true"]');
  await preview.first().waitFor();
  const firstPreviewMs = Math.round(performance.now() - startedAt);
  await preview.nth(1).waitFor();
  // A multi-paragraph preview can come from just one stream; establish both
  // occupied HTTP slots before testing that scrolling cancels both of them.
  for (let i = 0; streamReleases.size < 2 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(streamReleases.size, 2);
  assert.equal((await action("status")).completed, 0, "Preview is not counted as a finished translation");
  const scrolledAt = performance.now();
  await page.locator("#paragraph-20").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll(
    '[data-open-web-translator="translation"][aria-busy="true"]',
  )].some((element) => {
    const paragraph = Number(element.parentElement?.id.replace("paragraph-", ""));
    const rect = element.getBoundingClientRect();
    return paragraph >= 15 && rect.top < innerHeight && rect.bottom > 0;
  }), undefined, { timeout: 5_000 });
  const scrolledPreviewMs = Math.round(performance.now() - scrolledAt);
  for (let i = 0; cancelledStreams - beforeCancelledStreams < 2 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert(cancelledStreams - beforeCancelledStreams >= 2, "Scrolling releases both obsolete provider slots");
  assert.equal(await page.locator("article header [data-open-web-translator]").count(), 0,
    "Cancelled offscreen previews are removed");
  await action("stop");
  assert.equal(await preview.count(), 0, "Stop removes all unfinished previews");
  holdStreams = false;
  for (const release of streamReleases) release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await preview.count(), 0, "Late output cannot restore a stopped preview");
  console.log(`PASS 流式首字 ${firstPreviewMs}ms，滚动后新内容 ${scrolledPreviewMs}ms（本地 mock），离屏取消与预览清理`);

  await page.goto(`${base}/compact-article`);
  delay = 20;
  holdStreams = true;
  const compactCallsBefore = calls;
  const compactSizesBefore = requestSizes.length;
  const compactStarted = performance.now();
  await action("start");
  await page.locator('[data-open-web-translator][aria-busy="true"]').first().waitFor({ timeout: 5_000 });
  const compactFirstPreviewMs = Math.round(performance.now() - compactStarted);
  await page.locator('[data-open-web-translator][aria-busy="true"]').nth(3).waitFor({ timeout: 5_000 });
  assert(requestSizes.slice(compactSizesBefore).some((size) => size > 1), "one streaming request contains multiple paragraphs");
  assert.equal((await action("status")).completed, 0, "multi-paragraph previews remain provisional");
  holdStreams = false;
  for (const release of streamReleases) release();
  const compactState = await untilDone();
  assert.equal(compactState.completed, 8);
  assert.equal(compactState.failed, 0);
  const compactCompleteMs = Math.round(performance.now() - compactStarted);
  const compactRequests = calls - compactCallsBefore;
  assert(compactRequests <= 4, "eight short paragraphs use bounded batches, not eight requests");
  console.log(`PASS 同屏8短段，多段流式预览 ${compactFirstPreviewMs}ms，完成 ${compactCompleteMs}ms，${compactRequests}个请求（本地 mock）`);
  const compactTrace = await options.evaluate(() => chrome.runtime.sendMessage({ type: "diagnostics.get" }));
  assert.equal(compactTrace.ok, true);
  assert(compactTrace.result.page.some((event: any) => event.stage === "viewport.settled"));
  await writeFile(path.join(output, "compact-performance-trace.json"), JSON.stringify(compactTrace.result, null, 2));

  // Dynamic body and same-document navigation must continue after one manual start.
  await page.goto(`${base}/dynamic-article`);
  delay = 20;
  await action("start");
  const waitTranslation = async (selector: string, text: string) => page.waitForFunction(({ selector, text }) => {
    const source = document.querySelector(selector);
    const output = source?.querySelector(':scope > [data-open-web-translator="translation"]');
    return output?.hasAttribute("data-open-web-translator") && !output.hasAttribute("aria-busy") && output.textContent?.includes(text);
  }, { selector, text }, { timeout: 10_000 }).catch(async (error) => {
    // Isolated fixture data only, useful for navigation-race failures.
    console.error("Translation fixture failed", selector, text,
      await options.evaluate(() => chrome.storage.session.get(null)),
      (await options.evaluate(() => chrome.runtime.sendMessage({ type: "diagnostics.get" }))).result?.background,
      await action("status"));
    throw error;
  });
  await waitTranslation("#article-title", "Route alpha");
  await untilDone();
  const beforeAppendReceived = received.length;
  await page.evaluate(() => (window as any).dynamicArticle.appendParagraph("Dynamically appended English paragraph.", "added-proof"));
  await page.locator("#added-proof").scrollIntoViewIfNeeded();
  await waitTranslation("#added-proof", "Dynamically appended");
  assert.equal(received.slice(beforeAppendReceived).filter((text) => text === "Dynamically appended English paragraph.").length, 1);
  await page.evaluate(() => (window as any).dynamicArticle.editSequence(["Transient source A.", "Transient source B.", "Stable source C."], 10));
  await page.locator("#mutable-paragraph").scrollIntoViewIfNeeded();
  await waitTranslation("#mutable-paragraph", "Stable source C.");
  await page.locator("#source-link").click();
  assert.equal(await page.evaluate(() => (window as any).dynamicArticle.snapshot().linkClicks), 1);
  await page.evaluate(() => (window as any).dynamicArticle.navigate("beta"));
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitTranslation("#article-title", "Route beta");
  await page.evaluate(() => (window as any).dynamicArticle.back());
  await waitTranslation("#article-title", "Route alpha");
  await page.evaluate(() => (window as any).dynamicArticle.forward());
  await waitTranslation("#article-title", "Route beta");
  await page.evaluate(() => (window as any).dynamicArticle.replaceBody());
  await waitTranslation("#article-title", "Route beta");
  await action("stop");
  const afterDynamicStop = calls;
  await page.evaluate(() => (window as any).dynamicArticle.navigate("alpha"));
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(calls, afterDynamicStop, "stop disables same-document automatic continuation");
  console.log("PASS 动态追加、连续改文、链接事件、SPA续译、body替换、停止后不复活");

  const rule = await options.evaluate((origin) => chrome.runtime.sendMessage({ type: "site.set", origin, enabled: true }), base);
  assert.equal(rule.ok, true, JSON.stringify(rule));
  await page.reload();
  await waitTranslation("#article-title", "Route alpha");
  await page.evaluate(() => (window as any).dynamicArticle.navigate("beta", "replace"));
  await waitTranslation("#article-title", "Route beta");
  await action("restore");
  const afterAutoRestore = calls;
  await page.evaluate(() => (window as any).dynamicArticle.navigate("alpha"));
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(calls, afterAutoRestore, "restore suppresses automatic restart for this document");
  await page.reload();
  await waitTranslation("#article-title", "Route alpha");
  const disabled = await options.evaluate((origin) => chrome.runtime.sendMessage({ type: "site.set", origin, enabled: false }), base);
  // The isolated test grants required localhost access instead of a toolbar
  // gesture. Chrome forbids removing required access; the site rule must still
  // be disabled, its registration removed, and the current task stopped.
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error.code, "PERMISSION_REMOVE_FAILED", JSON.stringify(disabled));
  const disabledStatus = await options.evaluate(() => chrome.runtime.sendMessage({ type: "site.status" }));
  assert.equal(disabledStatus.result.enabled, false);
  assert.equal((await options.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, 0);
  assert.equal((await action("status")).status, "stopped");
  await page.reload();
  const afterDisable = calls;
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(calls, afterDisable, "disabled site does not run after reload");
  console.log("PASS 按站自动翻译、刷新启动、恢复本页抑制、关闭规则后不自动启动");

  await options.locator("#target-language").selectOption("ja");
  await options.locator("#display-mode").selectOption("translation-only");
  await options.locator("#save").click();
  await options.locator("#notice").filter({ hasText: "已保存" }).waitFor();
  await page.bringToFront();
  await page.goto(`${base}/dynamic-article`);
  const beforeJapanese = instructions.length;
  await action("start");
  await waitTranslation("#article-title", "Route alpha");
  assert.equal(await page.locator("#article-title").isVisible(), true, "the original host keeps its translated content visible");
  assert.equal(await page.locator('#article-title > [data-open-web-translator="translation"]').isVisible(), true);
  assert.equal(await page.locator("#article-title").evaluate((node) => node.firstChild?.textContent), "",
    "only the safe source text is hidden, leaving its host and translation in place");
  assert.equal(await page.locator("#source-link").isVisible(), true, "interactive source remains usable in translation-only mode");
  assert(instructions.slice(beforeJapanese).some((text) => text.includes("Japanese")));
  await action("restore");
  assert.equal(await page.locator("#article-title").isVisible(), true);
  assert.equal(await page.locator("#article-title").textContent(), "Route alpha article title");
  assert.equal(await page.locator("[data-open-web-translator-source-hidden]").count(), 0);
  await page.locator("#source-link").click();
  assert.equal(await page.evaluate(() => (window as any).dynamicArticle.snapshot().linkClicks), 1);
  await options.locator("#target-language").selectOption("zh-CN");
  await options.locator("#display-mode").selectOption("bilingual");
  await options.locator("#save").click();
  await options.locator("#notice").filter({ hasText: "已保存" }).waitFor();
  await page.bringToFront();
  console.log("PASS 目标语言传入模型指令、仅译文隐藏完成原段、保留交互、恢复原文");

  const diagnosticReply = await options.evaluate(() => chrome.runtime.sendMessage({ type: "diagnostics.get" }));
  assert.equal(diagnosticReply.ok, true);
  assert(diagnosticReply.result.host.some((event: any) => event.stage === "request.dispatch"));
  assert.doesNotMatch(JSON.stringify(diagnosticReply.result), /Dynamically appended English|Transient source|Bearer /);
  await writeFile(path.join(output, "performance-trace.json"), JSON.stringify(diagnosticReply.result, null, 2));

  await page.goto(`${base}/article`);
  delay = 30;
  failNext = true;
  await action("start");
  assert((await untilDone()).failed > 0);
  await action("retry");
  assert.equal((await untilDone()).failed, 0);
  console.log("PASS 失败段落重试");

  await page.reload();
  delay = 700;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await page.bringToFront();
  await popup.evaluate(() => document.querySelector<HTMLButtonElement>("#start")!.click());
  for (let i = 0; i < 50 && (await action("status")).status !== "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await popup.close();
  assert((await untilDone()).completed > 0, "Translation survives closing its UI");
  const reopenedPopup = await context.newPage();
  await reopenedPopup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  await page.bringToFront();
  await reopenedPopup.locator("#status-message").filter({ hasText: "当前正文已翻译" }).waitFor();
  assert.equal(await reopenedPopup.locator("#stop").isEnabled(), true, "completed pages can still stop dynamic discovery");
  await reopenedPopup.screenshot({ path: path.join(output, "popup.png") });
  await reopenedPopup.locator("#stop").evaluate((button) => (button as HTMLButtonElement).click());
  assert.equal((await action("status")).status, "stopped");
  await reopenedPopup.close();
  console.log("PASS 关闭弹窗后继续，重新打开恢复进度");

  await page.reload();
  await action("start");
  assert.equal((await action("stop")).status, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(await page.locator('[data-open-web-translator="translation"]').count(), 0);
  await action("retry");
  assert((await untilDone()).completed > 0);
  console.log("PASS 停止和继续未完成段落");

  await page.reload();
  delay = 700;
  await action("start");
  await action("restore");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(await page.locator('[data-open-web-translator="translation"]').count(), 0);
  console.log("PASS 恢复原文丢弃迟到结果");

  await new Promise((resolve) => setTimeout(resolve, 5_500));
  const reconnected = await options.evaluate(() => chrome.runtime.sendMessage({
    type: "host.request", command: { type: "status" },
  }));
  assert.equal(reconnected.ok, true);
  assert.equal(reconnected.result.settings.customModel, "local-test");
  console.log("PASS 短暂阅读停顿后仍可读取配置");

  // An ordinary webpage cannot invoke privileged extension operations.
  assert.equal(await page.evaluate(() => Boolean((window as unknown as { chrome?: { runtime?: unknown } }).chrome?.runtime)), false);
  const disk = JSON.parse(await readFile(path.join(root, "host-install/data/settings.json"), "utf8"));
  assert.equal(disk.customModel, "local-test");
  await writeFile(path.join(output, "browser-result.json"), JSON.stringify({
    success: true, browser: context.browser()?.version(), translationBlocks: translated.completed,
    provider: "local mock Chat Completions", chatgptLiveVerified: false,
    viewportPriority: true, progressiveBatches: true, scrollContinuation: true,
    idleWholePageContinuation: true, hiddenTabContinuation: true, stoppedContinuationStaysStopped: true,
    continuationRequests, continuationMaxConcurrency, continuationMaxDistantConcurrency,
    continuation: {
      beforeLeaving, whileAway, completed: continued.completed, total: continued.total,
      awayVisibility, readingScrollY, returnedScrollY,
    },
    forceRetranslation: true, articleHeader: true, stopWatching: true,
    popupPreparation: true, preparationReadyBeforeClick: true, firstModelRequestsReusePreparedSockets: true,
    streamedPreview: true, distantStreamCancellation: true, stoppedPreviewCleanup: true,
    dynamicContent: true, spaContinuation: true, siteAutomaticTranslation: true,
    targetLanguagePrompt: true, translationOnlyRestore: true,
    translationAppearance: true, appearanceWithoutRetranslation: true,
    floatingControls: { livePreference: true, brandIconLoaded: true, directToggle: true, cacheRestore: true, newRequests: 0 },
    customTranslationColors: true, liveColorPreview: true, customColorsAcrossThemes: true,
    persistentRefreshCache: { blocks: cachedPage.completed, newRequests: 0, indexedDbEntries: persisted.length },
    repeatedParagraphs: { paragraphs: 4, providerRequests: 1, submittedTexts: 1 },
    editedParagraphNewRequests: 1, cacheClearBySite: true, independentDisplayMode: true,
    languageFilter: { total: languageState.total, skipped: languageState.skipped, translated: languageState.completed, forceOverride: true },
    cancelledHttpStreams: cancelledStreams, actualModelUsage: "unknown: local mock has no billable model usage",
    clickToVisibleMs: clickTiming.values.clickToVisibleMs,
    firstPreviewMs, scrolledPreviewMs, compactFirstPreviewMs, compactCompleteMs, compactRequests,
  }, null, 2));
} finally {
  releaseViewportBatch?.();
  for (const release of streamReleases) release();
  for (const release of distantReleases) release();
  await browser?.close().catch(() => undefined);
  browserProcess.kill();
  await browserExited;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
