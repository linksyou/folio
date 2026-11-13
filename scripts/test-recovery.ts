/** Real installed extension + isolated browser + synthetic native port. No real credentials/model. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import type { PageAction, PageState } from "../src/shared/protocol.js";

const output = resolve("test-results/recovery");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(resolve("test-results/recovery-run-"));
const extension = resolve(temporary, "extension");
await cp("dist/extension", extension, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(extension, "manifest.json"), "utf8"));
// Fixture-only origin grant avoids needing a toolbar user gesture in headless CI.
manifest.host_permissions = ["https://folio.test/*"];
await writeFile(resolve(extension, "manifest.json"), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(resolve(temporary, "profile"), {
  channel: process.env.FOLIO_BROWSER_CHANNEL || "chromium",
  executablePath: process.env.FOLIO_BROWSER_EXECUTABLE || undefined,
  headless: true, viewport: { width: 1200, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
context.setDefaultTimeout(10_000);
const observations: unknown[] = [];
const errors: string[] = [];
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const fixture = await build({ entryPoints: ["tests/browser/native-fixture.ts"], bundle: true,
    format: "iife", globalName: "FolioFixture", write: false });
  await worker.evaluate(fixture.outputFiles[0].text + "\nFolioFixture.installNativeFixture();");
  const id = new URL(worker.url()).host;
  const article = await context.newPage();
  article.on("pageerror", error => errors.push(error.message));
  const prose = ["First", "Second", "Third", "Fourth"].map(word =>
    `<p>${word} paragraph explains how readers recover from a failed translation while keeping their place and previously translated content.</p>`).join("");
  await context.route("https://folio.test/**", route => route.fulfill({ contentType: "text/html",
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
      body{margin:0;background:#f6f7f9;color:#202124;font:18px/1.8 system-ui}
      main{max-width:720px;margin:60px auto;padding:0 28px}p{margin:24px 0}
      .folio-translation{display:block;color:#1769d2}
      @media(prefers-color-scheme:dark){body{background:#171a20;color:#e6e9ef}}
      </style></head><body><nav><input aria-label="Page input"><button id="site-button">Page action</button></nav><main>${prose}</main></body></html>` }));
  await article.goto("https://folio.test/article");
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: "https://folio.test/article" }))[0].id!);
  const popup = await context.newPage();
  popup.on("pageerror", error => errors.push(error.message));
  async function reopen() {
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await article.bringToFront();
  }
  await reopen();
  const action = (action: PageAction) => popup.evaluate(async action => {
    const reply = await chrome.runtime.sendMessage({ type: "page.action", action });
    return reply;
  }, action);
  const state = async (): Promise<PageState> => worker.evaluate(async tabId =>
    (await chrome.tabs.sendMessage(tabId, { type: "page.command", action: "status" }, { frameId: 0 })).result, tabId);
  async function waitState(predicate: (value: PageState) => boolean): Promise<PageState> {
    const deadline = Date.now() + 10_000;
    let value: PageState;
    do {
      value = await state();
      if (predicate(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    throw new Error("State wait timed out: " + JSON.stringify(value));
  }
  async function waitStatus(status: PageState["status"]) {
    return waitState(value => value.status === status);
  }
  const controls = article.locator('[data-folio-ui="floating"]');
  const panel = controls.locator(".panel");
  const primary = panel.locator(".primary");
  async function configure(mode: string, delay = 30, preflight = "") {
    await worker.evaluate(({ mode, delay, preflight }) => Object.assign(nativeFixture, { mode, delay, preflight }), { mode, delay, preflight });
  }
  async function fresh(mode: string, delay = 30) {
    await action("restore");
    await configure(mode, delay);
    // Disable persistent cache, so every scenario really reaches the mock.
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "cache.set", enabled: false }));
    await article.goto("https://folio.test/article");
    await article.bringToFront();
  }
  // Partial failure, state across reopening, dismiss and explicit retry.
  await configure("partial");
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "cache.set", enabled: false }));
  await article.locator("input").fill("Reader keeps editing here");
  assert((await action("start")).ok);
  const partial = await waitStatus("partial");
  assert.deepEqual([partial.completed, partial.failed, partial.total], [3, 1, 4]);
  assert.equal(partial.error?.code, "NETWORK_ERROR");
  assert.equal(await primary.textContent(), "重试失败的 1 段");
  assert.equal(await article.evaluate(() => document.activeElement?.tagName), "INPUT", "automatic feedback stole focus");
  assert.equal(await article.locator("input").inputValue(), "Reader keeps editing here");
  await article.screenshot({ path: resolve(output, "partial-page.png") });
  await reopen();
  await popup.waitForFunction(() => document.querySelector("#start")?.textContent === "重试失败的 1 段");
  await popup.locator(".panel").screenshot({ path: resolve(output, "partial-popup.png") });
  await panel.getByRole("button", { name: "关闭翻译面板" }).click();
  assert(await panel.isHidden());
  assert.match(await controls.locator(".badge").innerText(), /1 段失败/);
  await controls.locator(".badge").focus();
  await article.keyboard.press("Enter");
  assert(await panel.isVisible());
  const before = await worker.evaluate(() => nativeFixture.calls.length);
  await article.evaluate(() => {
    (window as unknown as { savedOutputs: Element[] }).savedOutputs = [...document.querySelectorAll('[data-folio="translation"]')];
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!.firstChild!);
    selection.removeAllRanges(); selection.addRange(range);
  });
  const selection = await article.evaluate(() => getSelection()!.toString());
  await configure("success", 200);
  // Race toolbar and page gestures, including a second retry while already running.
  await Promise.all([action("retry"), worker.evaluate(`chrome.scripting.executeScript({
    target: { tabId: ${tabId} }, func: () => chrome.runtime.sendMessage({ type: "page.control", action: "retry" })
  })`)]);
  await action("retry");
  await waitStatus("completed");
  assert.equal(await worker.evaluate(() => nativeFixture.calls.length), before + 1);
  assert(await article.evaluate(() => (window as unknown as { savedOutputs: Element[] }).savedOutputs.every(node => node.isConnected)));
  assert.equal(await article.evaluate(() => getSelection()!.toString()), selection);
  observations.push({ scenario: "partial-retry", partial, additionalParagraphRequests: 1, retainedOutputNodes: true, retainedSelection: true });
  await controls.locator(".badge").click();
  await article.screenshot({ path: resolve(output, "success-page.png") });
  // Dynamic prose continues; restore clears all feedback and output.
  await article.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend", "<p>New dynamic prose should translate when it appears in the article.</p>"));
  await waitState(value => value.completed === 5);
  await action("restore");
  assert.equal(await article.locator('[data-folio="translation"]').count(), 0);
  assert(await panel.isHidden());
  assert(await controls.locator(".badge").isHidden());
  observations.push({ scenario: "dynamic-and-restore", completed: 5 });
  // Total failure and keyboard close, theme/viewport checks.
  await fresh("all");
  await action("start");
  const failed = await waitStatus("failed");
  assert.equal(failed.completed, 0);
  assert.equal(failed.failed, 4);
  assert(!failed.message.includes("翻译完成"));
  assert.equal(await primary.textContent(), "重试 4 段");
  await article.screenshot({ path: resolve(output, "all-failed-page.png") });
  await reopen();
  await popup.waitForFunction(() => document.querySelector("#start")?.textContent === "重试 4 段");
  await popup.locator(".panel").screenshot({ path: resolve(output, "all-failed-popup.png") });
  for (const colorScheme of ["light", "dark"] as const) {
    await article.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await article.setViewportSize({ width: 360, height: 640 });
    await article.waitForFunction(() => {
      const box = document.querySelector('[data-folio-ui="floating"]')!.shadowRoot!.querySelector(".panel")!.getBoundingClientRect();
      return box.x >= 0 && box.right <= innerWidth && box.y >= 0 && box.bottom <= innerHeight;
    });
    const bounds = await panel.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360 && bounds.y >= 0 && bounds.y + bounds.height <= 640, JSON.stringify(bounds));
    await primary.focus();
    assert.equal(await primary.evaluate(el => getComputedStyle(el).outlineStyle), "solid");
    assert.equal(await controls.locator(".trigger").evaluate(el => getComputedStyle(el).transitionDuration), "0s");
    await article.screenshot({ path: resolve(output, `narrow-${colorScheme}.png`) });
  }
  await article.keyboard.press("Escape");
  assert(await panel.isHidden());
  assert(await controls.locator(".trigger").evaluate(el => el === (el.getRootNode() as ShadowRoot).activeElement));
  await controls.locator(".trigger").press("Enter");
  assert(await panel.isVisible());
  // 200% browser zoom: page scale via CDP does not change layout; use browser zoom API.
  await worker.evaluate(tabId => chrome.tabs.setZoom(tabId, 2), tabId);
  const zoomBounds = await panel.boundingBox();
  const viewport = await article.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(zoomBounds && zoomBounds.x >= 0 && zoomBounds.x + zoomBounds.width <= viewport.width + 1);
  await article.screenshot({ path: resolve(output, "zoom-200.png") });
  await worker.evaluate(tabId => chrome.tabs.setZoom(tabId, 1), tabId);
  await article.setViewportSize({ width: 1200, height: 900 });
  await article.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await panel.locator("summary").click();
  await article.waitForFunction(() => {
    const box = document.querySelector('[data-folio-ui="floating"]')!.shadowRoot!.querySelector(".panel")!.getBoundingClientRect();
    return box.bottom <= innerHeight;
  });
  await panel.locator("summary").click();
  await panel.getByRole("button", { name: "关闭翻译面板" }).click();
  const triggerBounds = (await controls.locator(".trigger").boundingBox())!;
  const dragRequests = await worker.evaluate(() => nativeFixture.calls.length);
  await article.mouse.move(triggerBounds.x + 20, triggerBounds.y + 20);
  await article.mouse.down();
  await article.mouse.move(30, 150, { steps: 8 });
  await article.mouse.up();
  assert.equal(await controls.getAttribute("data-edge"), "left");
  assert.equal(await worker.evaluate(() => nativeFixture.calls.length), dragRequests, "drag triggered translation");
  await controls.locator(".trigger").click();
  observations.push({ scenario: "all-failed-and-accessibility", failed, browserZoom: 2, narrowViewport: "360x640", themes: ["light", "dark"], reducedMotion: true });
  // Blockers during a request and before a job is created share page/popup state.
  for (const code of ["AUTH_EXPIRED", "CONFIG_REQUIRED", "HOST_UNAVAILABLE"]) {
    await fresh(`error:${code}`);
    await action("start");
    const paused = await waitStatus("paused");
    assert.equal(paused.error?.code, code);
    assert.match(await primary.innerText(), /登录|配置|连接/);
    assert(await panel.locator('[data-action="retry"]').isVisible());
    assert(!(await panel.innerText()).includes("secret-fixture-canary"));
    if (code === "HOST_UNAVAILABLE") {
      await article.screenshot({ path: resolve(output, "host-blocked-page.png") });
      const opened = context.waitForEvent("page");
      await primary.click();
      const options = await opened;
      await options.waitForURL(/options.html/);
      await options.close();
      await article.bringToFront();
    }
    await configure("success");
    await panel.locator('[data-action="retry"]').click();
    await waitStatus("completed");
    observations.push({ scenario: "blocked-recovery", code, paused });
  }
  await fresh("success");
  await configure("success", 30, "HOST_UNAVAILABLE");
  assert(!(await action("start")).ok);
  assert.equal((await waitStatus("paused")).error?.code, "HOST_UNAVAILABLE");
  await reopen();
  await popup.waitForFunction(() => document.querySelector("#start")?.textContent === "检查连接");
  await configure("success");
  await panel.locator('[data-action="retry"]').click();
  await waitStatus("completed");
  observations.push({ scenario: "preflight-recovery-and-reopen" });
  await action("restore");
  await article.evaluate(() => history.pushState({}, "", "/spa-error"));
  await configure("success", 30, "HOST_UNAVAILABLE");
  assert(!(await action("start")).ok);
  assert.equal((await waitStatus("paused")).error?.code, "HOST_UNAVAILABLE");
  assert.equal((await state()).error?.code, "HOST_UNAVAILABLE", "reading state discarded SPA preflight failure");
  await configure("success");
  await panel.locator('[data-action="retry"]').click();
  await waitStatus("completed");
  observations.push({ scenario: "spa-preflight-recovery" });
  await configure("success", 30, "HOST_UNAVAILABLE");
  await article.evaluate(() => history.pushState({}, "", "/spa-automatic"));
  assert.equal((await waitStatus("paused")).error?.code, "HOST_UNAVAILABLE");
  await configure("success");
  await panel.locator('[data-action="retry"]').click();
  await waitStatus("completed");
  observations.push({ scenario: "automatic-spa-preflight-recovery" });
  // A real native-port disconnect event, followed by a fresh mock port.
  await fresh("success", 400);
  await action("start");
  await waitStatus("running");
  await worker.evaluate(() => nativeFixture.disconnect());
  assert.equal((await waitStatus("paused")).error?.code, "HOST_UNAVAILABLE");
  await configure("success");
  await panel.locator('[data-action="retry"]').click();
  await waitStatus("completed");
  await article.waitForTimeout(450);
  assert.equal(await article.locator('[data-folio="translation"]').count(), 4);
  observations.push({ scenario: "native-port-disconnect-and-reconnect", completed: 4 });
  // Stop preserves success, rejects delayed output, and does not call cancellation failure.
  await fresh("partial");
  await action("start");
  await waitStatus("partial");
  await configure("success", 400);
  await action("retry");
  await waitStatus("running");
  await article.screenshot({ path: resolve(output, "running-page.png") });
  await primary.click();
  await waitStatus("stopped");
  assert.deepEqual([(await state()).completed, (await state()).failed], [3, 0]);
  await article.waitForTimeout(500); // Deliberate delayed mock response, bounded.
  assert.equal(await article.locator('[data-folio="translation"]').count(), 3);
  assert.equal((await state()).status, "stopped");
  await action("restore");
  assert.equal(await article.locator('[data-folio="translation"]').count(), 0);
  observations.push({ scenario: "stop-and-late-response", retained: 3, failed: 0 });
  // All target-language content must remain skipped after stop.
  await article.evaluate(() => { document.querySelector("main")!.innerHTML = "<p>这是中文内容，当前页面已经完成翻译，不需要再次请求模型。</p>"; });
  await action("start");
  const skipped = await waitStatus("completed");
  assert.equal(skipped.skipped, 1);
  await action("stop");
  assert.deepEqual([(await state()).skipped, (await state()).failed], [1, 0]);
  observations.push({ scenario: "already-target-language", skipped: 1, failed: 0 });
  await action("restore");
  await article.evaluate(() => document.querySelector("main")!.insertAdjacentHTML("beforeend",
    "<p>This English paragraph requires translation and receives an authentication error.</p>"));
  await configure("error:AUTH_EXPIRED");
  await action("start");
  const mixed = await waitStatus("paused");
  assert.deepEqual([mixed.total, mixed.skipped, mixed.failed], [2, 1, 1]);
  await action("stop");
  assert.deepEqual([(await state()).skipped, (await state()).failed], [1, 1]);
  observations.push({ scenario: "skipped-content-survives-pause", skipped: 1, failed: 1 });
  // Restore itself must also reject responses still in flight.
  await fresh("success", 400);
  await action("start");
  await action("restore");
  await article.waitForTimeout(450);
  assert.equal(await article.locator('[data-folio="translation"]').count(), 0);
  assert(await panel.isHidden());
  observations.push({ scenario: "restore-discards-late-response" });
  // Actual document navigation removes old panel/outputs and rejects old replies.
  await fresh("success", 400);
  await action("start");
  await article.goto("https://folio.test/next");
  await article.waitForTimeout(500);
  assert.equal(await article.locator('[data-folio="translation"]').count(), 0);
  assert.equal(await article.locator('[data-folio-ui="floating"]').count(), 0);
  observations.push({ scenario: "navigation-discards-late-response" });
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, "results.json"), JSON.stringify({
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
    browser: context.browser()?.version(), observations,
    scope: "Installed extension: real background/content/popup, Chrome messaging, storage and cache; synthetic native port and public fixture prose. Fixture-only origin grant. No real Host/account/model or toolbar permission UX.",
  }, null, 2));
  console.log(`PASS ${observations.length} installed-extension recovery scenarios; screenshots/results in test-results/recovery`);
} finally {
  await context.close();
  await rm(temporary, { recursive: true, force: true });
}
