import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type { ExtensionRequest, HostStatus, PageState, Result } from "../src/shared/protocol.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pageState(status: PageState["status"], message: string): PageState {
  return { status, total: 4, completed: status === "stopped" ? 3 : 4, failed: 0, message };
}

const hostStatus: HostStatus = {
  protocolVersion: 1,
  settingsRevision: "popup-revision",
  settings: {
    provider: "chatgpt",
    chatgptModel: "gpt-6-sol",
    chatgptReasoningEffort: "auto",
    customBaseUrl: "https://api.openai.com/v1",
    customModel: "",
    customReasoningEffort: "auto",
    hasApiKey: false,
  },
  auth: { state: "signed_in", profile: { id: "a", label: "账号 A" }, profiles: [{ id: "a", label: "账号 A" }], planEnabled: true },
};

for (const initialStatus of ["watching", "completed"] as const) {
test(`popup can stop ${initialStatus} continuation and rejects stale status responses`, async (t) => {
  const [html, bundle] = await Promise.all([
    readFile(path.join(root, "src/extension/popup.html"), "utf8"),
    build({ entryPoints: [path.join(root, "src/extension/popup.ts")], bundle: true, write: false, platform: "browser", format: "iife" }),
  ]);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://extension.test/popup.html" });
  t.after(() => dom.window.close());
  let pollTick!: () => void;
  Object.defineProperty(dom.window, "setInterval", {
    value: (callback: () => void) => { pollTick = callback; return 1; },
  });
  let statusCalls = 0;
  let stopCalls = 0;
  let resolveOldPoll!: (value: Result<PageState>) => void;
  const oldPoll = new Promise<Result<PageState>>((resolve) => { resolveOldPoll = resolve; });
  let resolveRetry!: (value: Result<PageState>) => void;
  const pendingRetry = new Promise<Result<PageState>>((resolve) => { resolveRetry = resolve; });
  const sendMessage = async (request: ExtensionRequest): Promise<unknown> => {
    if (request.type === "site.status") return { ok: true, result: { supported: false, enabled: false, permission: false } };
    if (request.type === "host.request") return {
      ok: true, result: request.command.type === "status" ? hostStatus : { ready: true },
    };
    if (request.type !== "page.action") throw new Error("unexpected request");
    if (request.action === "status") {
      statusCalls += 1;
      return statusCalls === 1
        ? { ok: true, result: pageState(initialStatus, "继续监听动态正文") }
        : oldPoll;
    }
    if (request.action === "stop") {
      stopCalls += 1;
      return { ok: true, result: pageState("stopped", "已停止") };
    }
    if (request.action === "retry") return pendingRetry;
    throw new Error(`unexpected action ${request.action}`);
  };
  Object.defineProperty(dom.window, "chrome", {
    value: { runtime: { sendMessage, openOptionsPage: () => undefined } },
  });
  dom.window.eval(bundle.outputFiles[0]!.text);
  await delay(20);

  const stop = dom.window.document.querySelector<HTMLButtonElement>("#stop")!;
  const message = dom.window.document.querySelector<HTMLElement>("#status-message")!;
  assert.equal(message.textContent, "继续监听动态正文");
  assert.equal(stop.disabled, false, "watching and completed pages still observe changes and must be stoppable");

  pollTick();
  pollTick();
  assert.equal(statusCalls, 2, "the next interval must not start while a status request is pending");
  stop.click();
  await delay(20);
  assert.equal(stopCalls, 1);
  assert.equal(message.textContent, "已停止");

  resolveOldPoll({ ok: true, result: pageState("watching", "过期状态") });
  await delay(20);
  assert.equal(message.textContent, "已停止");
  assert.equal(stop.disabled, true);

  // The old poll has settled. A new user action must still prevent the next
  // interval from starting a status request until that action is acknowledged.
  dom.window.document.querySelector<HTMLButtonElement>("#start")!.click();
  pollTick();
  pollTick();
  assert.equal(statusCalls, 2, "do not poll while a user action is pending");
  resolveRetry({ ok: true, result: pageState("running", "继续翻译") });
  await delay(0);
  assert.equal(message.textContent, "继续翻译");
});
}

test("popup prepares once, allows translation while pending, and tolerates failure", async (t) => {
  const [html, bundle] = await Promise.all([
    readFile(path.join(root, "src/extension/popup.html"), "utf8"),
    build({ entryPoints: [path.join(root, "src/extension/popup.ts")], bundle: true, write: false, platform: "browser", format: "iife" }),
  ]);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://extension.test/popup.html" });
  t.after(() => dom.window.close());
  let pollTick!: () => void;
  Object.defineProperty(dom.window, "setInterval", {
    value: (callback: () => void) => { pollTick = callback; return 1; },
  });
  let prepareCalls = 0;
  let startCalls = 0;
  let finishPreparation!: (response: unknown) => void;
  const preparation = new Promise((resolve) => { finishPreparation = resolve; });
  Object.defineProperty(dom.window, "chrome", { value: { runtime: {
    openOptionsPage: () => undefined,
    sendMessage: async (request: ExtensionRequest) => {
      if (request.type === "site.status") return { ok: true, result: { supported: false, enabled: false, permission: false } };
      if (request.type === "host.request") {
        if (request.command.type === "status") return { ok: true, result: hostStatus };
        assert.equal(request.command.type, "connection.prepare");
        prepareCalls++;
        return preparation;
      }
      assert.equal(request.type, "page.action");
      if (request.action === "start") startCalls++;
      return { ok: true, result: pageState("idle", "准备翻译") };
    },
  } } });
  dom.window.eval(bundle.outputFiles[0]!.text);
  await delay(0);
  const start = dom.window.document.querySelector<HTMLButtonElement>("#start")!;
  assert.equal(prepareCalls, 1);
  assert.equal(startCalls, 0, "opening the popup must not translate");
  assert.equal(start.disabled, false);
  start.click();
  await delay(0);
  assert.equal(startCalls, 1, "do not await preparation before handling the click");
  pollTick();
  await delay(0);
  assert.equal(prepareCalls, 1, "status polling must not start more preparation requests");

  finishPreparation({ ok: false, error: { code: "NETWORK_ERROR", message: "offline" } });
  await delay(0);
  assert.equal(dom.window.document.querySelector<HTMLElement>("#error")!.hidden, true);
  assert.match(dom.window.document.querySelector("#connection-preparation")!.textContent!, /点击翻译时/);
  start.click();
  await delay(0);
  assert.equal(startCalls, 2, "a preparation failure must not disable translation");
});

async function sitePopup(t: import("node:test").TestContext, hooks: {
  grant?: boolean;
  enabled?: boolean;
  ready?: boolean;
  removeFails?: boolean;
} = {}) {
  const [html, bundle] = await Promise.all([
    readFile(path.join(root, "src/extension/popup.html"), "utf8"),
    build({ entryPoints: [path.join(root, "src/extension/popup.ts")], bundle: true, write: false, platform: "browser", format: "iife" }),
  ]);
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://extension.test/popup.html" });
  t.after(() => dom.window.close());
  const requested: chrome.permissions.Permissions[] = [];
  const sent: ExtensionRequest[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  Object.defineProperty(dom.window, "setTimeout", { value: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length; } });
  Object.defineProperty(dom.window, "setInterval", { value: () => 1 });
  let enabled = hooks.enabled ?? false;
  const site = () => ({ supported: true, origin: "https://article.test", pattern: "https://article.test:443/*", enabled, permission: hooks.removeFails || enabled });
  Object.defineProperty(dom.window, "chrome", { value: {
    permissions: { request: async (permissions: chrome.permissions.Permissions) => { requested.push(permissions); return hooks.grant ?? true; } },
    runtime: {
      openOptionsPage() {},
      sendMessage: async (request: ExtensionRequest) => {
        sent.push(request);
        if (request.type === "site.status") return { ok: true, result: site() };
        if (request.type === "site.set") {
          enabled = request.enabled;
          if (!enabled && hooks.removeFails) return { ok: false, error: { code: "PERMISSION_REMOVE_FAILED", message: "自动翻译已关闭，但 Chrome 未能撤销此网站访问权限。" } };
          return { ok: true, result: site() };
        }
        if (request.type === "host.request") return { ok: true, result: request.command.type === "status" ? hostStatus : { ready: hooks.ready ?? true } };
        if (request.type === "page.action") return { ok: true, result: pageState("idle", "准备翻译") };
        throw new Error("unexpected request");
      },
    },
  } });
  dom.window.eval(bundle.outputFiles[0]!.text);
  await delay(0);
  return { dom, requested, sent, timers, toggle: dom.window.document.querySelector<HTMLInputElement>("#auto-translate")! };
}

test("popup requests just the current origin in the click gesture and persists only after grant", async (t) => {
  const harness = await sitePopup(t);
  harness.toggle.click();
  assert.deepEqual(harness.requested.map((item) => Array.from(item.origins ?? [])), [["https://article.test:443/*"]]);
  assert.equal(harness.sent.filter((request) => request.type === "site.set").length, 0, "await permission result before writing a rule");
  await delay(0);
  assert.equal(harness.toggle.checked, true);
  assert.deepEqual(harness.sent.filter((request) => request.type === "site.set").map((request) => request.enabled), [true]);
  const start = harness.sent.find((request) => request.type === "page.action" && request.action === "start");
  assert.ok(start && "clickedAtEpochMs" in start && Number.isFinite(start.clickedAtEpochMs));
});

test("popup permission denial leaves automatic translation disabled with an actionable message", async (t) => {
  const harness = await sitePopup(t, { grant: false });
  harness.toggle.click();
  await delay(0);
  assert.equal(harness.toggle.checked, false);
  assert.equal(harness.toggle.disabled, false);
  assert.equal(harness.sent.some((request) => request.type === "site.set"), false);
  assert.equal(harness.sent.some((request) => request.type === "page.action" && request.action === "start"), false);
  assert.match(harness.dom.window.document.querySelector("#error")!.textContent!, /未获得.*仍可手动翻译/);
});

test("disabling a site does not request a new permission", async (t) => {
  const harness = await sitePopup(t, { enabled: true });
  harness.toggle.click();
  await delay(0);
  assert.equal(harness.requested.length, 0);
  assert.equal(harness.toggle.checked, false);
  assert.deepEqual(harness.sent.filter((request) => request.type === "site.set").map((request) => request.enabled), [false]);
});

test("popup ready label expires before the native idle connection and stays usable", async (t) => {
  const harness = await sitePopup(t);
  const label = harness.dom.window.document.querySelector("#connection-preparation")!;
  assert.match(label.textContent!, /已就绪/);
  const expiry = harness.timers.find((timer) => timer.delay === 55_000);
  assert.ok(expiry);
  expiry.callback();
  assert.match(label.textContent!, /自动重连/);
  assert.equal(harness.dom.window.document.querySelector<HTMLButtonElement>("#start")!.disabled, false);
});

test("permission removal failure keeps the switch off and explains the remaining grant", async (t) => {
  const harness = await sitePopup(t, { enabled: true, removeFails: true });
  harness.toggle.click();
  await delay(0);
  assert.equal(harness.toggle.checked, false);
  assert.match(harness.dom.window.document.querySelector("#site-help")!.textContent!, /Chrome 仍报告/);
  assert.match(harness.dom.window.document.querySelector("#error")!.textContent!, /未能撤销/);
});
