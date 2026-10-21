import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { ExtensionRequest, HostStatus, Model, Result, SaveSettings } from "../src/shared/protocol.js";
import { DEFAULT_TRANSLATION_STYLE } from "../src/extension/translation-style.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = Promise.all([
  readFile(path.join(root, "src/extension/options.html"), "utf8"),
  readFile(path.join(root, "src/extension/ui.css"), "utf8"),
  build({ entryPoints: [path.join(root, "src/extension/options.ts")], bundle: true, write: false, platform: "browser", format: "iife" }),
]);

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
async function settle(): Promise<void> {
  await tick();
  await tick();
}

function status(overrides: Partial<HostStatus> = {}): HostStatus {
  return {
    protocolVersion: 1,
    settingsRevision: "revision-1",
    settings: {
      provider: "chatgpt",
      chatgptModel: "gpt-6-sol",
      chatgptReasoningEffort: "auto",
      customBaseUrl: "https://api.openai.com/v1",
      customModel: "custom-model",
      customReasoningEffort: "auto",
      hasApiKey: false,
    },
    auth: {
      state: "signed_in",
      profile: { id: "a", label: "账号 A" },
      profiles: [{ id: "a", label: "账号 A" }, { id: "b", label: "账号 B" }],
      planEnabled: true,
    },
    ...overrides,
  };
}

interface StyleStorage {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (values: Record<string, unknown>) => Promise<void>;
}

async function mount(sendMessage: (request: ExtensionRequest) => Promise<unknown>, storage: Partial<StyleStorage> = {}) {
  const [html, css, bundle] = await assets;
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://extension.test/options.html" });
  const style = dom.window.document.createElement("style");
  style.textContent = css;
  dom.window.document.head.append(style);
  const dialog = dom.window.document.querySelector<HTMLDialogElement>("#plan-welcome")!;
  Object.defineProperties(dialog, {
    showModal: { value: () => dialog.setAttribute("open", "") },
    close: { value: () => dialog.removeAttribute("open") },
  });
  Object.defineProperty(dom.window, "chrome", {
    value: {
      runtime: { sendMessage: (request: ExtensionRequest) => request.type === "cache.status"
        ? Promise.resolve({ ok: true, result: { enabled: true, entries: 0, bytes: 0, origins: [] } })
        : sendMessage(request) },
      storage: { local: { get: async () => ({ planUsageNoticeAcknowledged: true }), set: async () => undefined, ...storage } },
    },
  });
  dom.window.eval(bundle.outputFiles[0]!.text);
  await settle();
  return dom;
}

function values(dom: JSDOM, selector: string): string[] {
  return [...dom.window.document.querySelectorAll<HTMLOptionElement>(`${selector} option`)].map((option) => option.value);
}

test("offline options disable host actions and retry restores a signed-out UI", async () => {
  const signedOut = status({
    settings: { ...status().settings, chatgptModel: "" },
    auth: { state: "signed_out", profiles: [], planEnabled: false },
  });
  let statusCalls = 0;
  let resolveRetry!: (value: Result<HostStatus>) => void;
  const retryReply = new Promise<Result<HostStatus>>((resolve) => { resolveRetry = resolve; });
  const dom = await mount(async () => {
    statusCalls += 1;
    if (statusCalls === 1) return { ok: false, error: { code: "HOST_UNAVAILABLE", message: "本地辅助程序不可用。" } };
    return retryReply;
  });

  const controls = dom.window.document.querySelector<HTMLFieldSetElement>("#host-controls")!;
  const help = dom.window.document.querySelector<HTMLElement>("#host-help")!;
  const badge = dom.window.document.querySelector<HTMLElement>("#plan-badge")!;
  const retry = dom.window.document.querySelector<HTMLButtonElement>("#retry-host")!;
  assert.equal(controls.disabled, true);
  assert.equal(help.hidden, false);
  assert.match(help.textContent ?? "", /安装本地辅助程序，再重新检测/);
  assert.equal(dom.window.getComputedStyle(badge).display, "none");

  retry.click();
  assert.equal(retry.disabled, true);
  assert.equal(retry.textContent, "检测中…");
  resolveRetry({ ok: true, result: signedOut });
  await settle();

  assert.equal(controls.disabled, false);
  assert.equal(help.hidden, true);
  assert.match(dom.window.document.querySelector("#auth-summary")!.textContent ?? "", /尚未登录/);
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>("#refresh-models")!.disabled, true);
  assert.match(dom.window.document.querySelector("#model-status")!.textContent ?? "", /登录后/);
});

test("saving settings keeps the complete model catalog and selected model", async () => {
  const current = status();
  const catalog: Model[] = [
    { id: "gpt-6-sol", name: "GPT-6 Sol", reasoningEfforts: ["none", "low", "medium"] },
    { id: "gpt-6-astra", name: "GPT-6 Astra", reasoningEfforts: ["low", "high"] },
  ];
  let saved: SaveSettings | undefined;
  const dom = await mount(async (request) => {
    if (request.type !== "host.request") throw new Error("unexpected request");
    if (request.command.type === "status") return { ok: true, result: current };
    if (request.command.type === "models.list") return { ok: true, result: catalog };
    if (request.command.type === "settings.save") {
      saved = request.command.settings;
      return { ok: true, result: { ...current, settings: { ...current.settings, ...saved } } };
    }
    throw new Error(`unexpected command ${request.command.type}`);
  });
  assert.deepEqual(values(dom, "#chatgpt-model"), ["gpt-6-sol", "gpt-6-astra"]);

  const model = dom.window.document.querySelector<HTMLSelectElement>("#chatgpt-model")!;
  model.value = "gpt-6-astra";
  model.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  dom.window.document.querySelector<HTMLButtonElement>("#save")!.click();
  await settle();

  assert.equal(saved?.chatgptModel, "gpt-6-astra");
  assert.deepEqual(values(dom, "#chatgpt-model"), ["gpt-6-sol", "gpt-6-astra"]);
  assert.equal(model.value, "gpt-6-astra");
});

test("a failed refresh keeps the last catalog and its selection", async () => {
  const current = status();
  let modelCalls = 0;
  const dom = await mount(async (request) => {
    if (request.type !== "host.request") throw new Error("unexpected request");
    if (request.command.type === "status") return { ok: true, result: current };
    if (request.command.type === "models.list") {
      modelCalls += 1;
      return modelCalls === 1
        ? { ok: true, result: [{ id: "gpt-6-sol", name: "Sol" }, { id: "gpt-6-astra", name: "Astra" }] }
        : { ok: false, error: { code: "NETWORK_ERROR", message: "network down" } };
    }
    throw new Error(`unexpected command ${request.command.type}`);
  });
  const model = dom.window.document.querySelector<HTMLSelectElement>("#chatgpt-model")!;
  model.value = "gpt-6-astra";
  dom.window.document.querySelector<HTMLButtonElement>("#refresh-models")!.click();
  await settle();

  assert.deepEqual(values(dom, "#chatgpt-model"), ["gpt-6-sol", "gpt-6-astra"]);
  assert.equal(model.value, "gpt-6-astra");
  assert.match(dom.window.document.querySelector("#model-status")!.textContent ?? "", /继续使用上次/);
});

test("a late model response from the previous account cannot replace the active account", async () => {
  const accountA = status();
  const accountB = status({
    settingsRevision: "revision-b",
    settings: { ...status().settings, chatgptModel: "model-b" },
    auth: { state: "signed_in", profile: { id: "b", label: "账号 B" }, profiles: status().auth.profiles, planEnabled: true },
  });
  let active = "a";
  let resolveA!: (value: Result<Model[]>) => void;
  const modelsA = new Promise<Result<Model[]>>((resolve) => { resolveA = resolve; });
  const dom = await mount(async (request) => {
    if (request.type !== "host.request") throw new Error("unexpected request");
    if (request.command.type === "status") return { ok: true, result: accountA };
    if (request.command.type === "auth.select") { active = request.command.profileId; return { ok: true, result: accountB }; }
    if (request.command.type === "models.list") return active === "a" ? modelsA : { ok: true, result: [{ id: "model-b", name: "Model B" }] };
    throw new Error(`unexpected command ${request.command.type}`);
  });

  const profile = dom.window.document.querySelector<HTMLSelectElement>("#profile")!;
  profile.value = "b";
  profile.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  assert.deepEqual(values(dom, "#chatgpt-model"), ["model-b"]);

  resolveA({ ok: true, result: [{ id: "model-a", name: "Model A" }] });
  await settle();
  assert.deepEqual(values(dom, "#chatgpt-model"), ["model-b"]);
  assert.equal(dom.window.document.querySelector<HTMLSelectElement>("#chatgpt-model")!.value, "model-b");
});

test("supported ChatGPT and custom reasoning choices are submitted", async () => {
  const current = status();
  let saved: SaveSettings | undefined;
  const dom = await mount(async (request) => {
    if (request.type !== "host.request") throw new Error("unexpected request");
    if (request.command.type === "status") return { ok: true, result: current };
    if (request.command.type === "models.list") return { ok: true, result: [{ id: "gpt-6-sol", name: "Sol", reasoningEfforts: ["none", "low", "high"] }] };
    if (request.command.type === "settings.save") { saved = request.command.settings; return { ok: true, result: { ...current, settings: { ...current.settings, ...saved } } }; }
    throw new Error(`unexpected command ${request.command.type}`);
  });
  assert.deepEqual(values(dom, "#chatgpt-reasoning"), ["auto", "none", "low", "high"]);
  dom.window.document.querySelector<HTMLSelectElement>("#chatgpt-reasoning")!.value = "high";
  dom.window.document.querySelector<HTMLSelectElement>("#custom-reasoning")!.value = "low";
  dom.window.document.querySelector<HTMLButtonElement>("#save")!.click();
  await settle();

  assert.equal(saved?.chatgptReasoningEffort, "high");
  assert.equal(saved?.customReasoningEffort, "low");
});

test("a pending save is single-flight and renders the submitted snapshot", async () => {
  const current = status();
  let saveCalls = 0;
  let resolveSave!: (value: Result<HostStatus>) => void;
  const saveReply = new Promise<Result<HostStatus>>((resolve) => { resolveSave = resolve; });
  const dom = await mount(async (request) => {
    if (request.type !== "host.request") throw new Error("unexpected request");
    if (request.command.type === "status") return { ok: true, result: current };
    if (request.command.type === "models.list") return { ok: true, result: [
      { id: "gpt-6-sol", name: "Sol" },
      { id: "gpt-6-astra", name: "Astra" },
    ] };
    if (request.command.type === "settings.save") {
      saveCalls += 1;
      return saveReply;
    }
    throw new Error(`unexpected command ${request.command.type}`);
  });

  const save = dom.window.document.querySelector<HTMLButtonElement>("#save")!;
  const model = dom.window.document.querySelector<HTMLSelectElement>("#chatgpt-model")!;
  save.click();
  assert.equal(model.disabled, true);
  assert.equal(save.disabled, true);

  model.value = "gpt-6-astra";
  model.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  save.click();
  assert.equal(saveCalls, 1);

  resolveSave({ ok: true, result: { ...current, settingsRevision: "revision-2" } });
  await settle();
  assert.equal(model.value, "gpt-6-sol");
  assert.equal(model.disabled, false);
  assert.equal(saveCalls, 1);
  assert.match(dom.window.document.querySelector("#notice")!.textContent ?? "", /设置已保存/);
});

test("a failed account switch rolls the selector back and blocks a concurrent switch", async () => {
  const current = status();
  let selectCalls = 0;
  let resolveSelect!: (value: Result<HostStatus>) => void;
  const selectReply = new Promise<Result<HostStatus>>((resolve) => { resolveSelect = resolve; });
  const dom = await mount(async (request) => {
    if (request.type !== "host.request") throw new Error("unexpected request");
    if (request.command.type === "status") return { ok: true, result: current };
    if (request.command.type === "models.list") return { ok: true, result: [{ id: "gpt-6-sol", name: "Sol" }] };
    if (request.command.type === "auth.select") { selectCalls += 1; return selectReply; }
    throw new Error(`unexpected command ${request.command.type}`);
  });

  const profile = dom.window.document.querySelector<HTMLSelectElement>("#profile")!;
  profile.value = "b";
  profile.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(profile.disabled, true);

  profile.value = "a";
  profile.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(selectCalls, 1);

  resolveSelect({ ok: false, error: { code: "AUTH_REQUIRED", message: "auth failed" } });
  await settle();
  assert.equal(profile.value, "a");
  assert.equal(profile.disabled, false);
  assert.equal(selectCalls, 1);
});

test("target language saves with generation settings while legacy display migrates to browser storage", async () => {
  const current = status({ settings: { ...status().settings, targetLanguage: "ja", displayMode: "translation-only" } });
  let saved: SaveSettings | undefined;
  const stored: Record<string, unknown> = {};
  const dom = await mount(async (request) => {
    if (request.type !== "host.request") throw new Error("unexpected request");
    if (request.command.type === "status") return { ok: true, result: current };
    if (request.command.type === "models.list") return { ok: true, result: [{ id: "gpt-6-sol", name: "Sol" }] };
    if (request.command.type === "settings.save") {
      saved = request.command.settings;
      return { ok: true, result: { ...current, settings: { ...current.settings, ...saved } } };
    }
    throw new Error(`unexpected command ${request.command.type}`);
  }, { get: async () => stored, set: async (values) => { Object.assign(stored, values); } });
  const language = dom.window.document.querySelector<HTMLSelectElement>("#target-language")!;
  const display = dom.window.document.querySelector<HTMLSelectElement>("#display-mode")!;
  assert.equal(language.value, "ja");
  assert.equal(display.value, "translation-only");
  language.value = "en";
  display.value = "bilingual";
  display.dispatchEvent(new dom.window.Event("change"));
  dom.window.document.querySelector<HTMLButtonElement>("#save")!.click();
  await settle();
  assert.equal(saved?.targetLanguage, "en");
  assert.equal(saved?.displayMode, undefined, "presentation does not enter native settings.save");
  assert.equal(stored.translationDisplayMode, "bilingual");
  assert.equal(display.value, "bilingual", "a save response containing legacy mode cannot replace the local choice");
  dom.window.close();
});

const unavailable = { ok: false, error: { code: "HOST_UNAVAILABLE", message: "本地辅助程序不可用。" } };

function selectStyle(dom: JSDOM, id: string, value: string): void {
  const select = dom.window.document.getElementById(id) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function chooseColor(dom: JSDOM, id: string, value: string, event = "input"): void {
  const input = dom.window.document.getElementById(id) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
}

test("appearance loads and saves independently while the host is unavailable", async () => {
  let hostCalls = 0;
  const stored: Record<string, unknown> = { translationAppearance: { preset: "background", fontScale: 1.1 } };
  const dom = await mount(async () => { hostCalls += 1; return unavailable; }, {
    get: async () => stored,
    set: async (values) => { Object.assign(stored, values); },
  });
  try {
    const preset = dom.window.document.querySelector<HTMLSelectElement>("#translation-style-preset")!;
    assert.equal(preset.value, "background");
    assert.equal(preset.matches(":disabled"), false);
    assert.equal(preset.closest("#host-controls"), null);
    assert.equal(dom.window.document.querySelector<HTMLSelectElement>("#translation-font-scale")!.value, "1.1");
    selectStyle(dom, "translation-style-preset", "underline");
    assert.match(dom.window.document.querySelector("#translation-style-preview-css")!.textContent!, /text-decoration: underline/);
    await settle();
    assert.equal(JSON.stringify(stored.translationAppearance), JSON.stringify({ preset: "underline", fontScale: 1.1 }));
    assert.match(dom.window.document.querySelector("#translation-style-status")!.textContent!, /样式已保存/);
    assert.equal(hostCalls, 1, "changing appearance must not save host settings or call a model");
  } finally { dom.window.close(); }
});

test("appearance write failures are visible and reset can retry without the host", async () => {
  let fail = true;
  let persisted: unknown;
  const dom = await mount(async () => unavailable, {
    set: async (values) => {
      if (fail) throw new Error("storage unavailable");
      persisted = values.translationAppearance;
    },
  });
  try {
    selectStyle(dom, "translation-style-preset", "plain");
    await settle();
    const notice = dom.window.document.querySelector("#translation-style-status")!;
    assert.match(notice.textContent!, /保存失败，当前仅预览/);
    assert.equal(notice.classList.contains("danger-text"), true);
    fail = false;
    dom.window.document.querySelector<HTMLButtonElement>("#translation-style-reset")!.click();
    await settle();
    assert.equal(JSON.stringify(persisted), JSON.stringify(DEFAULT_TRANSLATION_STYLE));
    assert.match(notice.textContent!, /样式已保存/);
    assert.equal(notice.classList.contains("danger-text"), false);
  } finally { dom.window.close(); }
});

test("late appearance reads cannot replace edits and rapid writes keep the latest choice", async () => {
  let finishRead!: (value: Record<string, unknown>) => void;
  let finishFirstWrite!: () => void;
  const read = new Promise<Record<string, unknown>>((resolve) => { finishRead = resolve; });
  const firstWrite = new Promise<void>((resolve) => { finishFirstWrite = resolve; });
  const writes: unknown[] = [];
  let persisted: unknown;
  const dom = await mount(async () => unavailable, {
    get: async () => read,
    set: async (values) => {
      writes.push(values.translationAppearance);
      if (writes.length === 1) await firstWrite;
      persisted = values.translationAppearance;
    },
  });
  try {
    selectStyle(dom, "translation-style-preset", "background");
    await settle();
    selectStyle(dom, "translation-font-scale", "1.25");
    finishRead({ translationAppearance: { preset: "plain", fontScale: 0.9 } });
    await settle();
    assert.equal(writes.length, 1, "the second storage write waits for the first");
    assert.equal(dom.window.document.querySelector<HTMLSelectElement>("#translation-style-preset")!.value, "background");
    assert.equal(dom.window.document.querySelector<HTMLSelectElement>("#translation-font-scale")!.value, "1.25");
    assert.match(dom.window.document.querySelector("#translation-style-preview-css")!.textContent!, /font-size: 125%/);
    finishFirstWrite();
    await settle();
    assert.equal(writes.length, 2);
    assert.equal(JSON.stringify(persisted), JSON.stringify({ preset: "background", fontScale: 1.25, textColor: "#4a9834" }));
    assert.match(dom.window.document.querySelector("#translation-style-status")!.textContent!, /样式已保存/);
  } finally { dom.window.close(); }
});

test("appearance read failure is reported while controls remain usable", async () => {
  const dom = await mount(async () => unavailable, {
    get: async () => { throw new Error("read failed"); },
  });
  try {
    assert.match(dom.window.document.querySelector("#translation-style-status")!.textContent!, /无法读取已保存样式/);
    selectStyle(dom, "translation-style-preset", "plain");
    await settle();
    assert.match(dom.window.document.querySelector("#translation-style-status")!.textContent!, /样式已保存/);
  } finally { dom.window.close(); }
});

test("color input previews and persists immediately without a host or a change event", async () => {
  let hostCalls = 0;
  const stored: Record<string, unknown> = {
    translationAppearance: { preset: "plain", fontScale: 1.1, textColor: "#ABCDEF", backgroundColor: "#112233" },
  };
  const dom = await mount(async () => { hostCalls += 1; return unavailable; }, {
    get: async () => stored,
    set: async (values) => { Object.assign(stored, values); },
  });
  try {
    const input = dom.window.document.querySelector<HTMLInputElement>("#translation-text-color")!;
    assert.equal(input.value, "#abcdef");
    assert.equal(input.matches(":disabled"), false);
    assert.match(dom.window.document.querySelector("#translation-text-color-value")!.textContent!, /自定义\s+#ABCDEF/);
    chooseColor(dom, "translation-text-color", "#234567");
    assert.match(dom.window.document.querySelector("#translation-style-preview-css")!.textContent!, /--owt-text: #234567/);
    await settle();
    assert.equal(JSON.stringify(stored.translationAppearance), JSON.stringify({ preset: "plain", fontScale: 1.1, textColor: "#234567", backgroundColor: "#112233" }));
    chooseColor(dom, "translation-background-color", "#fedcba", "change");
    await settle();
    assert.match(dom.window.document.querySelector("#translation-style-preview-css")!.textContent!, /--owt-background: #fedcba/);
    assert.match(dom.window.document.querySelector("#translation-background-color-value")!.textContent!, /自定义\s+#FEDCBA/);
    assert.equal(hostCalls, 1);
  } finally { dom.window.close(); }
});

test("preset and font edits preserve custom colors while each default button resets only its color", async () => {
  let persisted: unknown;
  const dom = await mount(async () => unavailable, {
    get: async () => ({ translationAppearance: { preset: "background", fontScale: 1, textColor: "#123456", backgroundColor: "#fedcba" } }),
    set: async (values) => { persisted = values.translationAppearance; },
  });
  try {
    selectStyle(dom, "translation-style-preset", "underline");
    selectStyle(dom, "translation-font-scale", "1.25");
    await settle();
    assert.equal(JSON.stringify(persisted), JSON.stringify({ preset: "underline", fontScale: 1.25, textColor: "#123456", backgroundColor: "#fedcba" }));
    dom.window.document.querySelector<HTMLButtonElement>("#translation-text-color-reset")!.click();
    await settle();
    assert.equal(JSON.stringify(persisted), JSON.stringify({ preset: "underline", fontScale: 1.25, textColor: "#4a9834", backgroundColor: "#fedcba" }));
    assert.match(dom.window.document.querySelector("#translation-text-color-value")!.textContent!, /默认\s+#4A9834/);
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>("#translation-text-color-reset")!.disabled, true);
    chooseColor(dom, "translation-text-color", "#654321");
    dom.window.document.querySelector<HTMLButtonElement>("#translation-background-color-reset")!.click();
    await settle();
    assert.equal(JSON.stringify(persisted), JSON.stringify({ preset: "underline", fontScale: 1.25, textColor: "#654321" }));
    assert.match(dom.window.document.querySelector("#translation-background-color-value")!.textContent!, /默认 · 透明/);
    dom.window.document.querySelector<HTMLButtonElement>("#translation-style-reset")!.click();
    await settle();
    assert.equal(JSON.stringify(persisted), JSON.stringify(DEFAULT_TRANSLATION_STYLE));
  } finally { dom.window.close(); }
});

test("color bursts coalesce behind one active write and late reads cannot replace the final preview", async () => {
  let finishRead!: (value: Record<string, unknown>) => void;
  let finishFirstWrite!: () => void;
  const read = new Promise<Record<string, unknown>>((resolve) => { finishRead = resolve; });
  const firstWrite = new Promise<void>((resolve) => { finishFirstWrite = resolve; });
  const writes: unknown[] = [];
  let persisted: unknown;
  let active = 0;
  let maxActive = 0;
  const dom = await mount(async () => unavailable, {
    get: async () => read,
    set: async (values) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      writes.push(values.translationAppearance);
      if (writes.length === 1) await firstWrite;
      persisted = values.translationAppearance;
      active -= 1;
    },
  });
  try {
    chooseColor(dom, "translation-text-color", "#111111");
    for (let value = 0; value < 100; value += 1) chooseColor(dom, "translation-text-color", `#${value.toString(16).padStart(6, "0")}`);
    chooseColor(dom, "translation-background-color", "#eeeeee");
    chooseColor(dom, "translation-text-color", "#123abc", "change");
    finishRead({ translationAppearance: { preset: "plain", fontScale: 0.9, textColor: "#ff0000" } });
    await settle();
    assert.equal(writes.length, 1);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#translation-text-color")!.value, "#123abc");
    assert.match(dom.window.document.querySelector("#translation-style-preview-css")!.textContent!, /--owt-background: #eeeeee/);
    finishFirstWrite();
    await settle();
    assert.equal(writes.length, 2, "intermediate color selections are merged into one pending write");
    assert.equal(maxActive, 1);
    assert.equal(JSON.stringify(persisted), JSON.stringify({ preset: "plain", fontScale: 1, textColor: "#123abc", backgroundColor: "#eeeeee" }));
    assert.match(dom.window.document.querySelector("#translation-style-status")!.textContent!, /样式已保存/);
  } finally { dom.window.close(); }
});

test("display changes save with the host offline and storage failures are visible", async () => {
  const stored: Record<string, unknown> = { translationDisplayMode: "translation-only" };
  let calls = 0;
  let fail = false;
  const dom = await mount(async () => { calls += 1; return unavailable; }, {
    get: async () => stored,
    set: async (values) => { if (fail) throw new Error("storage failed"); Object.assign(stored, values); },
  });
  try {
    const display = dom.window.document.querySelector<HTMLSelectElement>("#display-mode")!;
    assert.equal(display.value, "translation-only");
    assert.equal(display.matches(":disabled"), false);
    assert.equal(display.closest("#host-controls"), null);
    selectStyle(dom, "display-mode", "bilingual");
    await settle();
    assert.equal(stored.translationDisplayMode, "bilingual");
    assert.match(dom.window.document.querySelector("#display-mode-status")!.textContent!, /已保存/);
    assert.equal(calls, 1, "display changes do not call the host or a model");
    fail = true;
    selectStyle(dom, "display-mode", "translation-only");
    await settle();
    assert.equal(stored.translationDisplayMode, "bilingual");
    assert.match(dom.window.document.querySelector("#display-mode-status")!.textContent!, /保存失败，尚未应用/);
    assert.equal(dom.window.document.querySelector("#display-mode-status")!.classList.contains("danger-text"), true);
  } finally { dom.window.close(); }
});

test("a late host status cannot migrate over an existing or newly selected display mode", async () => {
  for (const existing of [true, false]) {
    const stored: Record<string, unknown> = existing ? { translationDisplayMode: "bilingual" } : {};
    let finishStatus!: (value: unknown) => void;
    const pendingStatus = new Promise((resolve) => { finishStatus = resolve; });
    const dom = await mount(async (request) => {
      if (request.type === "host.request" && request.command.type === "status") return pendingStatus;
      return { ok: true, result: [] };
    }, { get: async () => stored, set: async (values) => { Object.assign(stored, values); } });
    try {
      if (!existing) selectStyle(dom, "display-mode", "bilingual");
      finishStatus({ ok: true, result: status({ settings: { ...status().settings, displayMode: "translation-only" } }) });
      await settle();
      assert.equal(stored.translationDisplayMode, "bilingual");
      assert.equal(dom.window.document.querySelector<HTMLSelectElement>("#display-mode")!.value, "bilingual");
    } finally { dom.window.close(); }
  }
});

test("rapid display selections serialize persistence and supersede a late initial read", async () => {
  let finishRead!: (value: Record<string, unknown>) => void;
  const read = new Promise<Record<string, unknown>>((resolve) => { finishRead = resolve; });
  let finishWrite!: () => void;
  const write = new Promise<void>((resolve) => { finishWrite = resolve; });
  const persisted: unknown[] = [];
  const dom = await mount(async () => unavailable, {
    get: async () => read,
    set: async (values) => { if (!Object.hasOwn(values, "translationDisplayMode")) return; if (!persisted.length) await write; persisted.push(values.translationDisplayMode); },
  });
  try {
    selectStyle(dom, "display-mode", "translation-only");
    await settle();
    selectStyle(dom, "display-mode", "bilingual");
    finishRead({ translationDisplayMode: "translation-only" });
    await settle();
    assert.equal(dom.window.document.querySelector<HTMLSelectElement>("#display-mode")!.value, "bilingual");
    finishWrite();
    await settle();
    assert.deepEqual(persisted, ["translation-only", "bilingual"]);
  } finally { dom.window.close(); }
});
