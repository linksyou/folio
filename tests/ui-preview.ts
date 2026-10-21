import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";

// The production UI is bundled locally and served over HTTP. No user browser,
// extension profile, credentials, native host or translation service is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src/extension");
const outputDir = path.join(root, "test-results/ui-preview");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png",
};

const popupMock = String.raw`
const scenario = new URL(location.href).searchParams.get("scenario") || "idle";
const states = {
  idle: { status: "idle", total: 0, completed: 0, failed: 0, message: "点击翻译正文，开始双语阅读。" },
  running: { status: "running", total: 24, completed: 9, skipped: 2, failed: 0, message: "正在翻译当前视口，优先呈现你正在阅读的内容。" },
  completed: { status: "completed", total: 24, completed: 22, skipped: 2, failed: 0, message: "当前正文已翻译，继续关注新增内容。" },
  failed: { status: "error", total: 24, completed: 18, skipped: 2, failed: 4, message: "部分段落翻译失败，可以重试。" },
  stopped: { status: "stopped", total: 24, completed: 9, skipped: 2, failed: 0, message: "已停止此页面的持续翻译。" },
  "long-labels": { status: "error", total: 24, completed: 18, skipped: 2, failed: 4, message: "部分段落暂时无法翻译，已经完成的译文仍然保留，可以重试失败段落或恢复原文。" },
};
let state = states[scenario] || states.idle;
let enabled = false;
const requests = [];
const storage = {};
const listeners = new Set();
const origin = scenario === "long-labels"
  ? "https://internationaldocumentationandtranslation.workspace-preview.example.com"
  : "https://github.com";
const site = () => scenario === "unsupported"
  ? { supported: false, enabled: false, permission: false }
  : { supported: true, enabled, permission: enabled, origin, pattern: origin + "/*" };
const account = scenario === "long-labels" ? "个人阅读与技术文档账号 · International Reader 日本語 한국어" : "个人账号";
const model = scenario === "long-labels" ? "multilingual-document-translation-model-long-preview-configuration-2026-日本語-한국어" : "gpt-6-sol";
const host = {
  protocolVersion: 1, settingsRevision: "ui-preview",
  settings: { provider: "chatgpt", targetLanguage: "zh-CN", chatgptModel: model, chatgptReasoningEffort: "auto", customBaseUrl: "", customModel: "", hasApiKey: false },
  auth: { state: "signed_in", profile: { id: "preview", label: account }, profiles: [{ id: "preview", label: account }], planEnabled: true },
};
globalThis.__preview = { requests, state: () => state, options: 0 };
globalThis.chrome = {
  runtime: {
    id: "ui-preview",
    openOptionsPage: async () => { globalThis.__preview.options++; },
    sendMessage: async request => {
      requests.push(request);
      if (request.type === "site.status") return { ok: true, result: site() };
      if (request.type === "site.set") { enabled = request.enabled; return { ok: true, result: site() }; }
      if (request.type === "diagnostics.get") return { ok: true, result: [] };
      if (request.type === "host.request") {
        if (scenario === "offline") return { ok: false, error: { code: "HOST_UNAVAILABLE", message: "本地辅助程序不可用，请打开设置检查连接。" } };
        return { ok: true, result: request.command.type === "status" ? host : { ready: true } };
      }
      if (request.type === "page.action") {
        if (scenario === "long-labels" && request.action === "retry") return {
          ok: false,
          error: { code: "NETWORK_ERROR", message: "翻译服务连接暂时中断，请检查网络后重试。已完成的译文会保留；若问题持续，请打开设置检查模型与账号。服务标识：international-document-translation-preview-endpoint-with-a-long-identifier。" },
        };
        if (request.action === "start" || request.action === "retry" || request.action === "retranslate") state = states.running;
        if (request.action === "stop") state = { ...state, status: "stopped", message: "已停止此页面的持续翻译。" };
        if (request.action === "restore") state = { ...states.idle, message: "已恢复原文。" };
        return { ok: true, result: state };
      }
      throw new Error("Unexpected preview request: " + request.type);
    },
  },
  permissions: { request: async permissions => { requests.push({ type: "permission", permissions }); return true; } },
  storage: {
    local: {
      get: async () => ({ ...storage }),
      set: async values => { const changes = {}; for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: storage[key], newValue: value }; storage[key] = value; } for (const listener of listeners) listener(changes, "local"); },
    },
    onChanged: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
  },
};
`;

const floatingFixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>网页悬浮工具验收</title>
<style>
  html { color-scheme: light dark; } body { margin: 0; background: #f5f5f7; color: #24262b; font: 16px/1.8 system-ui,sans-serif; }
  main { box-sizing: border-box; width: min(680px,100%); margin: 48px auto; padding: 28px; background: white; border-radius: 20px; }
  h1 { font-size: 25px; line-height: 1.4; } article p { color: #42454c; }
  .fixture-settings { padding: 14px; border-top: 1px solid #ddd; font-size: 13px; } input { width: auto; }
  /* Hostile page rules must not leak into the extension's shadow tree. */
  button { background: #ff00ff !important; color: #ff00ff !important; font-size: 64px !important; border-radius: 0 !important; }
  body > div { position: static !important; width: 1200px !important; }
  @media (prefers-color-scheme: dark) { body { background: #17181b; color: #f3f4f7; } main { background: #24262b; } article p { color: #c7c9d0; } }
</style></head><body><main><article><h1>Reading at your own pace</h1><p>A quiet book icon stays beside the article. Click once to translate, and again to show the original text.</p><p>Your reading position stays unchanged. The small icon remains subtle so you can focus on the page.</p></article>
<aside class="fixture-settings"><label><input id="floating-enabled" type="checkbox" checked> 设置：显示网页悬浮工具</label><p id="floating-status" role="status"></p></aside></main><script type="module" src="/floating-fixture.js"></script></body></html>`;

const floatingScript = `
import { FloatingControls } from "./src/extension/page/FloatingControls.ts";
import { initializeFloatingSettings, FLOATING_ENABLED_KEY, FLOATING_POSITION_KEY, floatingEnabled, floatingPosition } from "./src/extension/floating-settings.ts";
const changes = new Set();
const stored = JSON.parse(localStorage.getItem("preview-preferences") || "{}");
globalThis.chrome = { storage: {
  local: {
    get: async () => ({ ...stored }),
    set: async values => { const event = {}; for (const [key, value] of Object.entries(values)) { event[key] = { oldValue: stored[key], newValue: value }; stored[key] = value; } localStorage.setItem("preview-preferences", JSON.stringify(stored)); for (const listener of changes) listener(event, "local"); },
  }, onChanged: { addListener: listener => changes.add(listener), removeListener: listener => changes.delete(listener) },
} };
const idle = { status: "idle", total: 0, completed: 0, failed: 0, message: "随时翻译，轻松阅读。" };
const running = { status: "running", total: 12, completed: 4, failed: 0, message: "正在翻译当前视口。" };
const events = [];
let current = idle;
const widget = new FloatingControls(document, {
  action: async action => {
    events.push({ type: "action", action });
    await new Promise(resolve => setTimeout(resolve, 30));
    current = action === "restore" ? { ...idle, message: "已恢复原文。" } : action === "stop" ? { ...current, status: "stopped", message: "已停止此页面的持续翻译。" } : running;
    return { ok: true, result: current };
  },
  iconUrl: "/icons/icon-32.png",
  savePosition: async position => { events.push({ type: "position", position }); await chrome.storage.local.set({ [FLOATING_POSITION_KEY]: position }); },
});
widget.setEnabled(floatingEnabled(stored[FLOATING_ENABLED_KEY]));
widget.setPosition(floatingPosition(stored[FLOATING_POSITION_KEY]));
chrome.storage.onChanged.addListener(event => { if (event[FLOATING_ENABLED_KEY]) widget.setEnabled(floatingEnabled(event[FLOATING_ENABLED_KEY].newValue)); });
initializeFloatingSettings();
globalThis.__floatingPreview = { events, update: state => widget.update(state), dispose: () => widget.dispose() };
`;

async function assertFits(page: Page): Promise<void> {
  const size = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(size.scroll <= size.viewport, `horizontal overflow: ${size.scroll} > ${size.viewport}`);
}

async function assertTextReadable(page: Page, selector: string): Promise<void> {
  const metrics = await page.locator(selector).evaluate(element => {
    const box = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return { width: element.clientWidth, scrollWidth: element.scrollWidth,
      height: element.clientHeight, scrollHeight: element.scrollHeight,
      left: box.left, right: box.right, viewport: innerWidth,
      lineHeight: Number.parseFloat(css.lineHeight), whiteSpace: css.whiteSpace };
  });
  assert.ok(metrics.left >= 0 && metrics.right <= metrics.viewport + 1, `${selector} stays within the popup`);
  assert.ok(metrics.scrollWidth <= metrics.width + 1, `${selector} must wrap instead of overflowing horizontally`);
  assert.ok(metrics.scrollHeight <= metrics.height + 1, `${selector} must show its full text without clipping`);
  assert.notEqual(metrics.whiteSpace, "nowrap", `${selector} allows long content to wrap`);
  assert.ok(metrics.height > metrics.lineHeight * 1.5, `${selector} fixture exercises more than one text line`);
}

async function assertFloatingFits(page: Page): Promise<void> {
  await assertFits(page);
  const box = await page.locator('[data-open-web-translator-ui="floating"]').boundingBox();
  assert.ok(box);
  const viewport = page.viewportSize()!;
  assert.ok(box.x >= 0 && box.x + box.width <= viewport.width + 1);
  assert.ok(box.y >= 0 && box.y + box.height <= viewport.height + 1);
}

const [popupBundle, floatingBundle] = await Promise.all([
  build({ entryPoints: [path.join(sourceDir, "popup.ts")], bundle: true, platform: "browser", format: "esm", write: false }),
  build({ stdin: { contents: floatingScript, resolveDir: root, sourcefile: "ui-preview-fixture.ts", loader: "ts" }, bundle: true, platform: "browser", format: "esm", write: false }),
]);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    let body: string | Buffer;
    let extension = path.extname(pathname);
    if (pathname === "/popup.js") body = popupBundle.outputFiles[0]!.text;
    else if (pathname === "/popup-mock.js") body = popupMock;
    else if (pathname === "/floating-fixture.js") body = floatingBundle.outputFiles[0]!.text;
    else if (pathname === "/floating.html") body = floatingFixture;
    else if (pathname === "/popup.html") {
      body = (await readFile(path.join(sourceDir, "popup.html"), "utf8")).replace('<script type="module" src="./popup.js"></script>', '<script src="./popup-mock.js"></script><script type="module" src="./popup.js"></script>');
    } else if (pathname === "/ui.css" || /^\/icons\/icon-\d+\.png$/.test(pathname)) body = await readFile(path.join(sourceDir, pathname.slice(1)));
    else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": types[extension] ?? "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(body);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});

await mkdir(outputDir, { recursive: true });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("UI preview did not bind a TCP port");
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const screenshots: string[] = [];
const popupHeights: { scheme: string; scenario: string; height: number }[] = [];
const shot = async (page: Page, name: string) => {
  const destination = path.join(outputDir, `${name}.png`);
  if (name.startsWith("popup-")) await page.locator("main.panel").screenshot({ path: destination, animations: "disabled" });
  else await page.screenshot({ path: destination, fullPage: true, animations: "disabled" });
  screenshots.push(`${name}.png`);
};

try {
  for (const scheme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 360, height: 740 }, colorScheme: scheme, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    for (const scenario of ["idle", "running", "completed", "offline", "unsupported", "failed", "stopped", "long-labels"]) {
      await page.goto(`${base}/popup.html?scenario=${scenario}`);
      await page.waitForFunction(() => !document.getElementById("status-message")!.textContent!.includes("正在读取"));
      await page.waitForFunction(() => !document.getElementById("connection-summary")!.textContent!.includes("正在读取"));
      await assertFits(page);
      assert.equal(await page.locator("#connection-preparation").isVisible(), false, "connection details stay collapsed initially");
      const hasFailures = scenario === "failed" || scenario === "long-labels";
      assert.equal(await page.locator("#retry").isVisible(), hasFailures, `${scenario}: only failures reveal the retry action`);
      assert.equal(await page.locator("#retry").isDisabled(), !hasFailures, `${scenario}: hidden retry actions remain disabled`);
      if (scenario === "running") {
        assert.equal(await page.locator("#start").isDisabled(), true);
        assert.equal(await page.locator("#stop").isEnabled(), true);
      }
      if (scenario === "completed") {
        assert.equal(await page.locator("#restore").isEnabled(), true);
        assert.equal(await page.locator("#stop").isEnabled(), true);
      }
      if (scenario === "offline") assert.match(await page.locator("#error").textContent() ?? "", /本地辅助程序不可用/);
      if (scenario === "unsupported") assert.equal(await page.locator("#auto-translate").isDisabled(), true);
      if (scenario === "failed") {
        assert.match(await page.locator("#progress-text").textContent() ?? "", /失败 4 段/);
        assert.equal(await page.locator("#restore").isEnabled(), true);
      }
      if (scenario === "stopped") {
        assert.equal(await page.locator("#start").textContent(), "继续翻译");
        assert.equal(await page.locator("#start").isEnabled(), true);
        assert.equal(await page.locator("#stop").isDisabled(), true);
      }
      if (scenario === "long-labels") {
        await page.locator("#retry").click();
        await page.locator("#error").getByText(/服务标识/).waitFor();
        for (const selector of ["#status-message", "#site-summary", "#connection-summary", "#error"]) {
          await assertTextReadable(page, selector);
        }
        assert.equal(await page.locator("#retry").isEnabled(), true, "a failed request leaves retry available");
        await assertFits(page);
      }
      const panel = await page.locator("main.panel").boundingBox();
      assert.ok(panel);
      popupHeights.push({ scheme, scenario, height: Math.round(panel.height * 100) / 100 });
      if (scenario !== "long-labels") assert.ok(panel.height <= 600, `${scenario}: collapsed popup fits the usual 600px height`);
      await shot(page, `popup-${scenario}-${scheme}-360`);
      if (scenario === "long-labels") {
        await page.setViewportSize({ width: 360, height: 600 });
        await page.locator(".popup-more summary").scrollIntoViewIfNeeded();
        const lastControl = await page.locator(".popup-more summary").boundingBox();
        assert.ok(lastControl && lastControl.y >= 0 && lastControl.y + lastControl.height <= 601,
          "a long error may scroll, but the last control remains reachable in a 600px popup");
        await assertFits(page);
        await page.setViewportSize({ width: 360, height: 740 });
      }
      if (scenario === "failed" || scenario === "stopped") {
        await page.locator(scenario === "failed" ? "#retry" : "#start").click();
        await page.locator("#status-message").getByText(/正在翻译/).waitFor();
        const actions = await page.evaluate(() => (globalThis as any).__preview.requests
          .filter((request: any) => request.type === "page.action" && request.action !== "status")
          .map((request: any) => request.action));
        assert.deepEqual(actions, ["retry"], `${scenario}: the visible action resumes the existing page task`);
        assert.equal(await page.locator("#retry").isVisible(), false);
        assert.equal(await page.locator("#retry").isDisabled(), true);
        assert.equal(await page.locator("#stop").isEnabled(), true);
      }
    }
    await page.goto(`${base}/popup.html?scenario=idle`);
    await page.locator("#start").click();
    await page.locator("#status-message").getByText(/正在翻译/).waitFor();
    await page.locator("#stop").click();
    await page.locator("#status-message").getByText(/已停止/).waitFor();
    await page.locator("#start").click();
    await page.locator("#status-message").getByText(/正在翻译/).waitFor();
    await page.locator("#restore").click();
    await page.locator("#status-message").getByText("已恢复原文。").waitFor();
    await page.locator("#auto-translate").check();
    await page.waitForFunction(() => (globalThis as any).__preview.requests.some((request: any) => request.type === "site.set"));
    assert.equal(await page.locator("#auto-translate").isChecked(), true);
    await page.locator("#open-options").click();
    assert.equal(await page.evaluate(() => (globalThis as any).__preview.options), 1);
    await page.locator(".popup-more summary").click();
    assert.equal(await page.locator("#connection-preparation").isVisible(), true, "expanded details retain connection feedback");
    await assertFits(page);
    await shot(page, `popup-expanded-${scheme}-360`);
    const transition = await page.locator("#progress-bar").evaluate(element => getComputedStyle(element).transitionDuration);
    assert.ok(transition.split(",").every(value => Number.parseFloat(value) <= .01), "popup respects reduced motion");
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, colorScheme: "light" });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/floating.html`);
  const host = page.locator('[data-open-web-translator-ui="floating"]');
  const trigger = host.locator(".trigger");
  await trigger.waitFor();
  assert.equal(await host.locator("button").count(), 1);
  assert.equal(await host.locator(".panel").count(), 0);
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-open-web-translator-ui]')?.shadowRoot?.querySelector("img");
    return img?.complete && img.naturalWidth === 32;
  });
  const style = await trigger.evaluate(element => {
    const css = getComputedStyle(element);
    return { background: css.backgroundColor, opacity: Number(css.opacity), width: css.width };
  });
  assert.equal(style.width, "40px");
  assert.ok(style.opacity <= .6, "idle entry remains quiet");
  assert.notEqual(style.background, "rgb(255, 0, 255)");
  await assertFloatingFits(page);
  await shot(page, "floating-quiet-light");
  await trigger.click();
  await page.waitForFunction(() => document.querySelector('[data-open-web-translator-ui]')!.shadowRoot!.querySelector("button")!.getAttribute("aria-label") === "显示原文");
  await page.mouse.move(200, 500);
  await shot(page, "floating-translated-light");
  await trigger.click();
  await page.waitForFunction(() => document.querySelector('[data-open-web-translator-ui]')!.shadowRoot!.querySelector("button")!.getAttribute("aria-label") === "翻译此页");
  const events = await page.evaluate(() => (globalThis as any).__floatingPreview.events);
  assert.deepEqual(events.filter((event: any) => event.type === "action").map((event: any) => event.action), ["start", "restore"]);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[data-open-web-translator-ui]')!.shadowRoot!.querySelector("button")!.getAttribute("aria-label") === "显示原文");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector('[data-open-web-translator-ui]')!.shadowRoot!.querySelector("button")!.getAttribute("aria-label") === "翻译此页");

  const drag = async (x: number, y: number, edge: "left" | "right") => {
    const before = await page.evaluate(() => (globalThis as any).__floatingPreview.events.filter((e: any) => e.type === "action").length);
    const box = await trigger.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 12 });
    await page.mouse.up();
    assert.equal(await host.getAttribute("data-edge"), edge);
    assert.equal(await page.evaluate(() => (globalThis as any).__floatingPreview.events.filter((e: any) => e.type === "action").length), before, "dragging does not translate");
    await assertFloatingFits(page);
  };
  await drag(28, 740, "left");
  await shot(page, "floating-left-light");
  await drag(1000, 20, "right");
  await page.reload();
  await trigger.waitFor();
  assert.equal(await host.getAttribute("data-edge"), "right");
  await page.setViewportSize({ width: 360, height: 520 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.mouse.move(100, 300);
  await assertFloatingFits(page);
  await shot(page, "floating-quiet-dark-360");
  assert.equal(await trigger.evaluate(element => getComputedStyle(element).transitionDuration), "0s");
  await page.setViewportSize({ width: 320, height: 480 });
  await assertFloatingFits(page);
  await shot(page, "floating-quiet-dark-320");
  await page.locator("#floating-enabled").uncheck();
  await page.locator("#floating-status").getByText(/已关闭/).waitFor();
  assert.equal(await trigger.isVisible(), false);
  await page.reload();
  await page.waitForFunction(() => Boolean((globalThis as any).__floatingPreview));
  assert.equal(await trigger.isVisible(), false);
  await page.locator("#floating-enabled").check();
  await page.locator("#floating-status").getByText(/已开启/).waitFor();
  await assertFloatingFits(page);
  await page.evaluate(() => (globalThis as any).__floatingPreview.dispose());
  assert.equal(await host.count(), 0);
  await page.close();

  assert.deepEqual(errors, [], "all preview pages are free of uncaught JavaScript errors");
  const result = { popupScenarios: 16, popupInteractionFlows: 6, popupLongTextChecks: 2, floatingInteractionFlows: 1, popupHeights, screenshots, pageErrors: errors,
    evidence: "Real isolated Chromium, production UI source, mocked extension callbacks; no model requests or user profile access." };
  await writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`小窗与悬浮工具验收通过：16 个小窗状态、6 套小窗操作链、2 套长文案检查、原书页图标/单击翻译与恢复/拖动/键盘/设置开关，${screenshots.length} 张截图。`);
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
