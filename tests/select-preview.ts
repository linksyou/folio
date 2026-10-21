import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright";

/** Real picker interactions: selectOption() alone never opens the menu. */
export async function verifySettingsSelects(browser: Browser, baseUrl: string, outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const pages: Page[] = [];
  const errors: string[] = [];
  const checks: Array<{ scenario: string; geometry?: unknown }> = [];

  async function create(width = 1280, height = 900, colorScheme: "light" | "dark" = "light", scenario = "signed-in"): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme, reducedMotion: "reduce" });
    pages.push(page);
    page.on("pageerror", (error) => errors.push(error.message));
    const url = new URL(baseUrl);
    url.searchParams.set("scenario", scenario);
    await page.goto(url.href);
    await page.locator(scenario === "offline" ? "#host-help" : "#model-status").waitFor();
    if (scenario !== "offline") await page.getByText("已读取 2 个模型。", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => CSS.supports("appearance", "base-select")), true, "this test browser must support customizable select");
    return page;
  }

  async function position(page: Page, selector: string, top: number): Promise<void> {
    await page.locator(selector).evaluate((element, target) => {
      window.scrollBy({ top: element.getBoundingClientRect().top - target, behavior: "instant" });
    }, top);
  }

  async function open(page: Page, selector: string): Promise<void> {
    await page.locator(selector).click();
    await page.waitForFunction((query) => document.querySelector(query)?.matches(":open"), selector);
    await page.locator(`${selector} option`).first().waitFor({ state: "visible" });
  }

  async function geometry(page: Page, selector: string) {
    return page.locator(selector).evaluate((element) => {
      const select = element as HTMLSelectElement;
      const control = select.getBoundingClientRect();
      const first = select.options[0]!.getBoundingClientRect();
      const picker = getComputedStyle(select, "::picker(select)");
      const horizontal = parseFloat(picker.paddingLeft) + parseFloat(picker.paddingRight) + parseFloat(picker.borderLeftWidth) + parseFloat(picker.borderRightWidth);
      const vertical = parseFloat(picker.paddingTop) + parseFloat(picker.paddingBottom) + parseFloat(picker.borderTopWidth) + parseFloat(picker.borderBottomWidth);
      const width = parseFloat(picker.width) + (picker.boxSizing === "border-box" ? 0 : horizontal);
      const height = parseFloat(picker.height) + (picker.boxSizing === "border-box" ? 0 : vertical);
      // Tests inspect the first option before navigating/scrolling inside the picker.
      const left = first.left - parseFloat(picker.paddingLeft) - parseFloat(picker.borderLeftWidth);
      const top = first.top - parseFloat(picker.paddingTop) - parseFloat(picker.borderTopWidth);
      return {
        control: { left: control.left, top: control.top, right: control.right, bottom: control.bottom, width: control.width },
        menu: { left, top, right: left + width, bottom: top + height, width, height },
        firstOption: { width: first.width, height: first.height },
        viewport: { width: innerWidth, height: innerHeight },
        pageWidth: document.documentElement.scrollWidth,
      };
    });
  }

  async function assertMenu(page: Page, selector: string, scenario: string, direction?: "below" | "above") {
    const value = await geometry(page, selector);
    const { menu, control, viewport } = value;
    assert.ok(menu.width > 0 && menu.height > 0, `${scenario}: picker has measurable dimensions`);
    assert.ok(Math.abs(menu.left - control.left) <= 2, `${scenario}: picker aligns with control left edge`);
    assert.ok(Math.abs(menu.width - control.width) <= 2, `${scenario}: picker matches control width`);
    assert.ok(menu.left >= -1 && menu.right <= viewport.width + 1, `${scenario}: picker stays inside viewport horizontally`);
    assert.ok(menu.top >= -1 && menu.bottom <= viewport.height + 1, `${scenario}: picker stays inside viewport vertically`);
    assert.ok(menu.bottom <= control.top + 1 || menu.top >= control.bottom - 1, `${scenario}: picker does not cover its control`);
    if (direction === "below") assert.ok(menu.top > control.bottom, `${scenario}: opens below with a gap`);
    if (direction === "above") assert.ok(menu.bottom < control.top, `${scenario}: flips above with a gap`);
    assert.ok(value.pageWidth <= viewport.width, `${scenario}: page has no horizontal overflow`);
    checks.push({ scenario, geometry: value });
    await page.screenshot({ path: path.join(outputDir, `select-${scenario}.png`), animations: "disabled" });
    return value;
  }

  async function assertClosed(page: Page, selector: string): Promise<void> {
    assert.equal(await page.locator(selector).evaluate((element) => element.matches(":open")), false);
  }

  try {
    const desktop = await create();
    const language = "#target-language";
    await position(desktop, language, 250);
    await open(desktop, language);
    await assertMenu(desktop, language, "language-below-light", "below");
    await desktop.locator(`${language} option[value="en"]`).click();
    assert.equal(await desktop.locator(language).inputValue(), "en");
    await assertClosed(desktop, language);

    await desktop.locator(language).focus();
    await desktop.keyboard.press("Space");
    await desktop.keyboard.press("ArrowDown");
    await desktop.keyboard.press("Escape");
    await assertClosed(desktop, language);
    assert.equal(await desktop.locator(language).inputValue(), "en", "Escape does not commit a different language");
    assert.equal(await desktop.locator(language).evaluate((element) => document.activeElement === element), true, "Escape returns focus to the select");
    await desktop.keyboard.press("Space");
    await desktop.keyboard.press("ArrowDown");
    await desktop.keyboard.press("Enter");
    await assertClosed(desktop, language);
    assert.equal(await desktop.locator(language).inputValue(), "ja", "keyboard commits the next language");
    await open(desktop, language);
    await desktop.keyboard.press("Tab");
    await assertClosed(desktop, language);
    await open(desktop, language);
    await desktop.mouse.click(12, 400);
    await assertClosed(desktop, language);
    checks.push({ scenario: "mouse-keyboard-commit-dismiss" });

    // The first option keeps the menu geometry measurable before internal scrolling.
    await desktop.locator(language).selectOption("zh-CN");
    await position(desktop, language, 650);
    await open(desktop, language);
    await assertMenu(desktop, language, "language-above-light", "above");
    await desktop.keyboard.press("Escape");

    const model = "#chatgpt-model";
    await desktop.locator(model).evaluate((element) => {
      const select = element as HTMLSelectElement;
      select.replaceChildren(...Array.from({ length: 60 }, (_, index) => new Option(
        `Model ${index + 1} · A deliberately long multilingual model name 用来检查窄列中长选项的换行与完整显示`,
        `long-${index}`, false, index === 0,
      )));
    });
    await position(desktop, model, 220);
    await open(desktop, model);
    const longMenu = await assertMenu(desktop, model, "long-models-scroll-light", "below");
    assert.ok(longMenu.menu.height <= 340, "long catalogs use a bounded scrolling menu");
    assert.ok(longMenu.firstOption.height > 40, "long option text wraps instead of overflowing");
    await desktop.keyboard.press("End");
    await desktop.keyboard.press("Enter");
    assert.equal(await desktop.locator(model).inputValue(), "long-59", "last item in a long catalog is reachable");
    await assertClosed(desktop, model);
    const selectedModelDimensions = await desktop.locator(model).evaluate((element) => {
      const field = element.closest<HTMLElement>(".field")!;
      return { field: field.clientWidth, content: field.scrollWidth, viewport: innerWidth, page: document.documentElement.scrollWidth };
    });
    assert.ok(selectedModelDimensions.content <= selectedModelDimensions.field, "selected long model does not overflow its field");
    assert.ok(selectedModelDimensions.page <= selectedModelDimensions.viewport, "selected long model does not widen the page");
    checks.push({ scenario: "dynamic-model-catalog-last-option" });

    for (const width of [390, 320]) {
      const mobile = await create(width, 844, "dark");
      await position(mobile, language, 240);
      await open(mobile, language);
      await assertMenu(mobile, language, `language-dark-${width}`, "below");
      await mobile.keyboard.press("Escape");
      await mobile.locator("#cache-origin").evaluate((element) => {
        const select = element as HTMLSelectElement;
        select.replaceChildren(new Option("https://very-long-domain-with-a-readable-complete-name.example.test", "long-domain", true, true));
        select.disabled = false;
      });
      await position(mobile, "#cache-origin", 240);
      await open(mobile, "#cache-origin");
      await assertMenu(mobile, "#cache-origin", `long-domain-dark-${width}`);
      await mobile.keyboard.press("Escape");
    }

    const offline = await create(390, 844, "light", "offline");
    assert.equal(await offline.locator(language).isDisabled(), true, "Host fieldset disables language selection");
    await position(offline, language, 240);
    const disabledBox = await offline.locator(language).boundingBox();
    assert.ok(disabledBox);
    await offline.mouse.click(disabledBox.x + disabledBox.width / 2, disabledBox.y + disabledBox.height / 2);
    await assertClosed(offline, language);
    await position(offline, "#translation-style-preset", 240);
    assert.equal(await offline.locator("#translation-style-preset").isEnabled(), true);
    await open(offline, "#translation-style-preset");
    await assertMenu(offline, "#translation-style-preset", "offline-appearance-light-390", "below");
    await offline.locator('#translation-style-preset option[value="underline"]').click();
    await offline.locator("#translation-style-status").getByText(/样式已保存/).waitFor();
    assert.equal(await offline.locator("#translation-style-preview").evaluate((element) => getComputedStyle(element).textDecorationLine), "underline");
    checks.push({ scenario: "offline-disabled-host-live-appearance" });

    const short = await create(1280, 400);
    await position(short, language, 180);
    await open(short, language);
    await short.screenshot({ path: path.join(outputDir, "select-low-height-light.png"), animations: "disabled" });
    await assertMenu(short, language, "low-height-light");
    await short.keyboard.press("End");
    await short.keyboard.press("Enter");
    assert.equal(await short.locator(language).inputValue(), "es", "last language remains reachable when both sides have little space");
    checks.push({ scenario: "low-height-last-language-reachable" });

    const accessible = await create(900, 700);
    await accessible.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await position(accessible, language, 200);
    await open(accessible, language);
    await assertMenu(accessible, language, "forced-colors-reduced-motion", "below");
    const animation = await accessible.locator(language).evaluate((element) => getComputedStyle(element, "::picker(select)").animationName);
    assert.equal(animation, "none", "reduced motion disables menu animation");
    for (const hover of [false, true]) {
      const selected = accessible.locator(`${language} option:checked`);
      if (hover) await selected.hover();
      const colors = await selected.evaluate((element) => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
      const luminance = (color: string): number => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((channel) => {
          const value = channel / 255;
          return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        });
        return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
      };
      const foreground = luminance(colors.foreground), background = luminance(colors.background);
      const contrast = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      await accessible.screenshot({ path: path.join(outputDir, `select-forced-colors${hover ? "-hover" : ""}.png`), animations: "disabled" });
      assert.ok(contrast >= 4.5, `forced colors selected ${hover ? "hover " : ""}text remains readable: contrast ${contrast.toFixed(2)}, ${JSON.stringify(colors)}`);
    }
    await accessible.keyboard.press("Escape");
    checks.push({ scenario: "forced-colors-selection-hover-contrast-reduced-motion" });

    assert.deepEqual(errors, [], "settings picker interactions produce no page errors");
    await writeFile(path.join(outputDir, "select-result.json"), JSON.stringify({ checks, pageErrors: errors }, null, 2));
    console.log(`选择框真实交互验收通过：${checks.length} 项，${errors.length} 个页面异常`);
  } finally {
    await Promise.all(pages.map((page) => page.close()));
  }
}
