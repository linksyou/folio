import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { verifySettingsSelects } from "./select-preview.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "dist/extension");
const outputDir = path.join(root, "test-results/options-preview");
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};

const mockSource = String.raw`
const scenario = new URL(location.href).searchParams.get("scenario") || "signed-in";
const baseSettings = {
  targetLanguage: "zh-CN",
  displayMode: "bilingual",
  provider: scenario === "custom" ? "custom" : "chatgpt",
  chatgptModel: "gpt-6-sol",
  chatgptReasoningEffort: "auto",
  customBaseUrl: "http://127.0.0.1:8787/v1",
  customModel: "local-translate-model",
  customReasoningEffort: "auto",
  hasApiKey: true,
};
const signedIn = {
  protocolVersion: 1,
  settingsRevision: "preview-revision",
  settings: baseSettings,
  auth: {
    state: "signed_in",
    profile: { id: "personal", label: "个人账号", email: "reader@example.com" },
    profiles: [{ id: "personal", label: "个人账号", email: "reader@example.com" }],
    planEnabled: true,
  },
};
const custom = {
  ...signedIn,
  settings: { ...baseSettings, provider: "custom" },
  auth: { state: "signed_out", profiles: [], planEnabled: false },
};
const reading = {
  ...signedIn,
  settings: { ...baseSettings, targetLanguage: "ja", displayMode: "translation-only" },
};
const currentStatus = scenario === "custom" ? custom : scenario === "reading" ? reading : signedIn;
globalThis.chrome = {
  runtime: {
    sendMessage: async (request) => {
      if (request.type?.startsWith("cache.")) return { ok: true, result: { enabled: true, entries: 27, bytes: 6144, origins: ["https://example.com"] } };
      const command = request.command;
      if (scenario === "offline") return { ok: false, error: { code: "HOST_UNAVAILABLE", message: "本地辅助程序不可用。" } };
      if (command?.type === "status") return { ok: true, result: currentStatus };
      if (command?.type === "models.list") return { ok: true, result: [
        { id: "gpt-6-sol", name: "GPT-6 Sol", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"] },
        { id: "gpt-6-astra", name: "GPT-6 Astra", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      ] };
      return { ok: true, result: currentStatus };
    },
  },
  storage: { local: {
    get: async () => ({ planUsageNoticeAcknowledged: true, translationAppearance: JSON.parse(localStorage.getItem("translationAppearance") || "null") }),
    set: async (values) => {
      if (values.translationAppearance) localStorage.setItem("translationAppearance", JSON.stringify(values.translationAppearance));
    },
  } },
};
`;

async function capturePage(page: Page, filename: string): Promise<void> {
  // Full-page screenshots otherwise pin sticky navigation at a prior assertion's scroll position.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  if (filename === "signed-in-models.png") {
    await page.screenshot({ path: path.join(outputDir, "settings-desktop.png"), animations: "disabled" });
  }
  await page.screenshot({ path: path.join(outputDir, filename), fullPage: true });
}

async function assertFits(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    footerRight: document.querySelector(".footer-actions")?.getBoundingClientRect().right ?? 0,
  }));
  assert.ok(dimensions.scroll <= dimensions.viewport, `horizontal overflow: ${dimensions.scroll} > ${dimensions.viewport}`);
  assert.ok(dimensions.footerRight <= dimensions.viewport + 1, "sticky action bar extends past the viewport");
}

async function assertReadingPreferences(page: Page, language: string, mode: string): Promise<void> {
  const reading = page.locator('[aria-labelledby="reading-title"]');
  await reading.waitFor({ state: "visible" });
  assert.equal(await page.locator("#target-language").inputValue(), language);
  assert.equal(await page.locator("#display-mode").inputValue(), mode);
  const fallback = page.getByText(/含链接、交互控件或嵌套结构的段落保留双语/);
  await fallback.scrollIntoViewIfNeeded();
  assert.equal(await fallback.isVisible(), true, "translation-only fallback explanation must remain visible");
  assert.match(await fallback.textContent() ?? "", /译文完成后隐藏对应原文/);
  assert.match(await fallback.textContent() ?? "", /恢复原文时还原/);
  if (mode === "translation-only") {
    assert.equal(await page.locator("#display-mode option:checked").textContent(), "仅显示译文");
  }
}

async function changeAppearance(page: Page, preset: string, scale: string): Promise<void> {
  await page.locator("#translation-style-preset").selectOption(preset);
  await page.locator("#translation-font-scale").selectOption(scale);
  await page.locator("#translation-style-status").getByText(/样式已保存/).waitFor();
  assert.equal(await page.locator("#translation-style-preview").evaluate((element) => getComputedStyle(element).fontSize), `${16 * Number(scale)}px`);
}

async function changeColors(page: Page, textColor: string, backgroundColor: string): Promise<void> {
  for (const [id, color] of [["translation-text-color", textColor], ["translation-background-color", backgroundColor]]) {
    await page.locator(`#${id}`).evaluate((element, value) => {
      (element as HTMLInputElement).value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, color!);
  }
  await page.locator("#translation-style-status").getByText(/样式已保存/).waitFor();
  await page.waitForFunction(({ textColor, backgroundColor }) => {
    const style = JSON.parse(localStorage.getItem("translationAppearance") || "null");
    return style?.textColor === textColor && style?.backgroundColor === backgroundColor;
  }, { textColor, backgroundColor });
}

async function assertPreviewColors(page: Page, textColor: string, backgroundColor: string): Promise<void> {
  const computed = await page.locator("#translation-style-preview").evaluate((element) => {
    const style = getComputedStyle(element);
    return { textColor: style.color, backgroundColor: style.backgroundColor };
  });
  assert.deepEqual(computed, { textColor, backgroundColor });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/mock.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(mockSource);
      return;
    }
    const relative = url.pathname === "/" ? "options.html" : url.pathname.slice(1);
    if (!/^(?:[a-z0-9_.-]+|icons\/icon-\d+\.png)$/i.test(relative)) throw new Error("invalid preview path");
    const filePath = path.join(extensionDir, relative);
    let body = await readFile(filePath);
    if (relative === "options.html") {
      const html = body.toString("utf8").replace('<script type="module" src="./options.js"></script>', '<script src="./mock.js"></script><script type="module" src="./options.js"></script>');
      body = Buffer.from(html);
    }
    response.writeHead(200, { "content-type": contentTypes[path.extname(relative)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  } catch (error) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : "not found");
  }
});

await mkdir(outputDir, { recursive: true });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("preview server did not bind a TCP port");
const baseUrl = `http://127.0.0.1:${address.port}/options.html`;
const browser = await chromium.launch({ headless: true });

try {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  await desktop.goto(`${baseUrl}?scenario=signed-in`);
  await desktop.locator("#model-status").getByText("已读取 2 个模型。").waitFor();
  assert.deepEqual(await desktop.locator("#chatgpt-model option").allTextContents(), ["GPT-6 Sol", "GPT-6 Astra"]);
  await assertReadingPreferences(desktop, "zh-CN", "bilingual");
  await assertFits(desktop);
  await capturePage(desktop, "signed-in-models.png");

  await desktop.goto(`${baseUrl}?scenario=custom`);
  await desktop.locator("#custom-section").waitFor();
  assert.equal(await desktop.locator("#custom-section").isVisible(), true);
  assert.equal(await desktop.locator("#custom-endpoint").textContent(), "http://127.0.0.1:8787/v1/chat/completions");
  await assertFits(desktop);
  await capturePage(desktop, "custom-api.png");

  await desktop.goto(`${baseUrl}?scenario=reading`);
  await desktop.locator("#model-status").getByText("已读取 2 个模型。").waitFor();
  await assertReadingPreferences(desktop, "ja", "translation-only");
  await assertFits(desktop);
  await capturePage(desktop, "reading-japanese-translation-only.png");

  await changeAppearance(desktop, "underline", "1.1");
  assert.equal(await desktop.locator("#translation-style-preview").evaluate((element) => getComputedStyle(element).textDecorationLine), "underline");
  await changeAppearance(desktop, "plain", "0.9");
  assert.equal(await desktop.locator("#translation-style-preview").evaluate((element) => getComputedStyle(element).textDecorationLine), "none");
  await changeAppearance(desktop, "background", "1.25");
  await assertFits(desktop);
  await desktop.locator(".translation-style-card").screenshot({ path: path.join(outputDir, "translation-appearance-light.png") });
  await desktop.reload();
  await desktop.waitForFunction(() => (document.getElementById("translation-font-scale") as HTMLSelectElement)?.value === "1.25");
  assert.equal(await desktop.locator("#translation-style-preset").inputValue(), "background");

  await changeColors(desktop, "#1e3a5f", "#e8f1fc");
  await changeAppearance(desktop, "plain", "1.1");
  await assertPreviewColors(desktop, "rgb(30, 58, 95)", "rgb(232, 241, 252)");
  await desktop.emulateMedia({ colorScheme: "dark" });
  await assertPreviewColors(desktop, "rgb(30, 58, 95)", "rgb(232, 241, 252)");
  await desktop.emulateMedia({ colorScheme: "light" });
  await assertFits(desktop);
  await desktop.locator(".translation-style-card").screenshot({ path: path.join(outputDir, "translation-colors-light.png") });
  await desktop.reload();
  await desktop.waitForFunction(() => (document.getElementById("translation-text-color") as HTMLInputElement)?.value === "#1e3a5f");
  await assertPreviewColors(desktop, "rgb(30, 58, 95)", "rgb(232, 241, 252)");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  await mobile.goto(`${baseUrl}?scenario=custom`);
  await mobile.locator("#custom-section").waitFor();
  await assertFits(mobile);
  await capturePage(mobile, "custom-api-mobile-dark.png");

  await mobile.goto(`${baseUrl}?scenario=reading`);
  await mobile.locator("#model-status").getByText("已读取 2 个模型。").waitFor();
  await assertReadingPreferences(mobile, "ja", "translation-only");
  await assertFits(mobile);
  await capturePage(mobile, "reading-japanese-translation-only-mobile-dark.png");

  await mobile.goto(`${baseUrl}?scenario=offline`);
  await mobile.locator("#host-help").waitFor();
  assert.notEqual(await mobile.locator("#host-controls").getAttribute("disabled"), null);
  assert.match(await mobile.locator("#host-state").textContent() ?? "", /未连接/);
  assert.equal(await mobile.locator("#translation-style-preset").isEnabled(), true);
  assert.equal(await mobile.locator("#translation-text-color").inputValue(), "#4a9834");
  await changeAppearance(mobile, "background", "1.25");
  await assertFits(mobile);
  await capturePage(mobile, "offline-mobile-dark.png");
  await mobile.locator(".translation-style-card").screenshot({ path: path.join(outputDir, "translation-appearance-mobile-dark.png") });
  await changeColors(mobile, "#dbeafe", "#162b44");
  await assertPreviewColors(mobile, "rgb(219, 234, 254)", "rgb(22, 43, 68)");
  await assertFits(mobile);
  await mobile.locator(".translation-style-card").screenshot({ path: path.join(outputDir, "translation-colors-mobile-dark.png") });
  await mobile.locator("#translation-background-color-reset").click();
  await mobile.locator("#translation-style-status").getByText(/样式已保存/).waitFor();
  await assertPreviewColors(mobile, "rgb(219, 234, 254)", "rgb(36, 59, 48)");
  await mobile.locator("#translation-style-reset").click();
  await mobile.locator("#translation-style-status").getByText(/样式已保存/).waitFor();
  assert.equal(await mobile.locator("#translation-style-preset").inputValue(), "plain");
  assert.equal(await mobile.locator("#translation-font-scale").inputValue(), "1");
  assert.equal(await mobile.locator("#translation-text-color").inputValue(), "#4a9834");
  assert.equal(await mobile.locator("#translation-background-color-reset").isDisabled(), true);
  await assertPreviewColors(mobile, "rgb(74, 152, 52)", "rgba(0, 0, 0, 0)");

  await desktop.locator('[aria-labelledby="cache-title"]').screenshot({ path: path.join(outputDir, "translation-cache-light.png") });
  await mobile.locator('[aria-labelledby="cache-title"]').screenshot({ path: path.join(outputDir, "translation-cache-mobile-dark.png") });
  await verifySettingsSelects(browser, baseUrl, outputDir);
  console.log(`设置页可视化验收通过：${path.relative(root, outputDir)}`);
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
