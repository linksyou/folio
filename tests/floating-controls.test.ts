import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { FloatingControls, type FloatingControlsCallbacks, type FloatingPosition } from "../src/extension/page/FloatingControls.js";
import type { PageAction, PageState } from "../src/shared/protocol.js";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const state = (status: PageState["status"], completed = 0): PageState => ({ status, total: 4, completed, failed: 0, message: "当前页面状态" });
function fixture(overrides: Partial<FloatingControlsCallbacks> = {}) {
  const dom = new JSDOM("<!DOCTYPE html><main><p id='source'>Original page text.</p></main>", { pretendToBeVisual: true });
  const actions: PageAction[] = [];
  const positions: FloatingPosition[] = [];
  const controls = new FloatingControls(dom.window.document, {
    iconUrl: "chrome-extension://fixture/icons/icon-32.png",
    action: async (action) => { actions.push(action); return { ok: true, result: state(action === "restore" ? "idle" : "running") }; },
    savePosition: async (position) => { positions.push(position); }, ...overrides,
  });
  const host = dom.window.document.querySelector<HTMLElement>("[data-open-web-translator-ui]")!;
  const shadow = host.shadowRoot!;
  const trigger = shadow.querySelector<HTMLButtonElement>(".trigger")!;
  const cleanup = () => { controls.dispose(); dom.window.close(); };
  return { dom, controls, host, shadow, trigger, actions, positions, cleanup };
}

test("one branded toggle uses isolated DOM and survives a replaced body", () => {
  const f = fixture();
  assert.equal(f.host.parentElement, f.dom.window.document.documentElement);
  assert.equal(f.host.hasAttribute("data-open-web-translator"), false);
  assert.equal(f.shadow.querySelectorAll("button").length, 1);
  assert.equal(f.shadow.querySelector(".panel"), null);
  assert.equal(f.shadow.querySelector("img")!.src, "chrome-extension://fixture/icons/icon-32.png");
  assert.equal(f.dom.window.document.body.textContent, "Original page text.");
  f.dom.window.document.body.replaceWith(f.dom.window.document.createElement("body"));
  assert(f.host.isConnected);
  f.cleanup();
});

test("click translates immediately and the next click restores originals", async () => {
  const f = fixture();
  await f.trigger.click(); await settle();
  assert.deepEqual(f.actions, ["start"]);
  assert.equal(f.trigger.getAttribute("aria-label"), "显示原文");
  f.trigger.click(); await settle();
  assert.deepEqual(f.actions, ["start", "restore"]);
  assert.equal(f.trigger.getAttribute("aria-label"), "翻译此页");
  f.trigger.click(); await settle();
  assert.deepEqual(f.actions, ["start", "restore", "start"]);
  for (const status of ["running", "watching", "completed", "paused", "stopped", "error"] as const) {
    f.controls.update(state(status, 2));
    f.trigger.click(); await settle();
    assert.equal(f.actions.at(-1), "restore", "existing translations always switch back to originals");
  }
  f.cleanup();
});

test("pending clicks are deduplicated, newer progress wins over an old acknowledgement", async () => {
  let finish!: (value: Awaited<ReturnType<FloatingControlsCallbacks["action"]>>) => void;
  let calls = 0;
  const f = fixture({ action: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  f.trigger.click(); f.trigger.click();
  assert.equal(calls, 1);
  assert.equal(f.trigger.getAttribute("aria-busy"), "true");
  f.controls.update(state("completed", 4));
  finish({ ok: true, result: state("running") }); await settle();
  assert.equal(f.trigger.dataset.status, "completed");
  f.trigger.click();
  f.controls.dispose();
  finish({ ok: true, result: state("idle") }); await settle();
  assert.equal(f.host.isConnected, false);
  f.cleanup();
});

test("errors stay text-only without adding a panel and permit retry", async () => {
  const f = fixture({ action: async () => ({ ok: false, error: { code: "HOST_UNAVAILABLE", message: "<img src=x>请检查本地程序" } }) });
  f.trigger.click(); await settle();
  assert.equal(f.trigger.title, "<img src=x>请检查本地程序");
  assert.equal(f.shadow.querySelector(".announcement")!.children.length, 0);
  assert.equal(f.shadow.querySelectorAll("img").length, 1);
  assert.equal(f.trigger.getAttribute("aria-busy"), "false");
  f.cleanup();
});

test("disabled entry cannot translate, re-enabling preserves existing state", async () => {
  const f = fixture();
  f.controls.setEnabled(false); f.trigger.click(); await settle();
  assert.equal(f.host.hidden, true); assert.deepEqual(f.actions, []);
  f.controls.update(state("completed", 4));
  f.controls.setEnabled(true); f.trigger.click(); await settle();
  assert.deepEqual(f.actions, ["restore"]);
  f.cleanup();
});

test("dragging snaps to an edge, clamps position and never starts translation", async () => {
  const f = fixture();
  const pointer = (type: string, target: EventTarget, x: number, y: number) => {
    const event = new f.dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, composed: true });
    Object.defineProperty(event, "pointerId", { value: 1 }); target.dispatchEvent(event);
  };
  pointer("pointerdown", f.trigger, 990, 348);
  pointer("pointermove", f.dom.window, -100, -1000);
  pointer("pointerup", f.dom.window, -100, -1000);
  f.trigger.dispatchEvent(new f.dom.window.MouseEvent("click", { detail: 1, bubbles: true, composed: true }));
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.positions, [{ edge: "left", ratio: 0 }]);
  assert.equal(f.host.style.top, "14px");
  await settle();
  f.controls.setPosition({ edge: "right", ratio: 100 });
  assert.equal(f.host.style.right, "14px");
  assert.equal(Number.parseFloat(f.host.style.top), f.dom.window.innerHeight - 54);
  Object.defineProperty(f.dom.window, "innerHeight", { value: 200, configurable: true });
  f.dom.window.dispatchEvent(new f.dom.window.Event("resize"));
  assert.equal(f.host.style.top, "146px");
  const oldStyle = f.host.getAttribute("style"); f.controls.dispose();
  Object.defineProperty(f.dom.window, "innerHeight", { value: 400, configurable: true });
  f.dom.window.dispatchEvent(new f.dom.window.Event("resize"));
  assert.equal(f.host.getAttribute("style"), oldStyle); f.cleanup();
});
