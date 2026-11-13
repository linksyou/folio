import assert from "node:assert/strict";
import { test } from "node:test";
import { pageError, pageFeedback } from "../src/shared/page-feedback.js";
import type { PageState } from "../src/shared/protocol.js";

const state = (overrides: Partial<PageState>): PageState => ({
  status: "idle", total: 4, completed: 0, failed: 0, message: "", ...overrides,
});
test("partial failure offers one-paragraph retry, never regeneration", () => {
  const view = pageFeedback(state({ status: "partial", completed: 3, failed: 1,
    error: { code: "NETWORK_ERROR", message: "secret api key" } }));
  assert.equal(view.primary, "retry");
  assert.equal(view.label, "重试失败的 1 段");
  assert.match(view.message, /3 \/ 4 段.*1 段失败.*网络连接失败/);
  assert(!view.message.includes("secret"));
});
test("all failure is not completion or restore", () => {
  const view = pageFeedback(state({ status: "failed", failed: 4, error: pageError({ code: "TIMEOUT" }) }));
  assert.equal(view.label, "重试 4 段");
  assert.match(view.message, /尚未译出内容.*超时/);
  assert(!view.message.includes("翻译完成"));
});
for (const code of ["AUTH_EXPIRED", "AUTH_REQUIRED", "CONFIG_REQUIRED", "HOST_UNAVAILABLE"]) {
  test(`${code} offers settings and an explicit resume after recovery`, () => {
    const view = pageFeedback(state({ status: "paused", completed: 1, failed: 1,
      skipped: 1, continuing: false, error: pageError({ code }) }));
    assert.equal(view.primary, "settings");
    assert.equal(view.remaining, 2);
    assert.equal(view.retryLabel, "继续未完成的 2 段");
    assert.match(view.progress, /1 段无需翻译.*1 段失败.*1 段未完成/);
    assert.equal(view.stoppable, false);
  });
}
test("stop and restore have separate meanings; skipped paragraphs never need retry", () => {
  assert.equal(pageFeedback(state({ status: "running" })).primary, "stop");
  assert.equal(pageFeedback(state({ status: "completed", completed: 4 })).primary, "restore");
  const skipped = pageFeedback(state({ status: "completed", skipped: 4 }));
  assert.equal(skipped.remaining, 0);
  assert.equal(skipped.primary, "stop");
  const stopped = pageFeedback(state({ status: "stopped", completed: 2, skipped: 1 }));
  assert.equal(stopped.label, "继续未完成的 1 段");
  assert.equal(stopped.stoppable, false);
});
test("unknown error codes and arbitrary server messages never cross the display boundary", () => {
  for (const code of ["https://secret.invalid/?token=secret", "__proto__", "toString"]) {
    assert.deepEqual(pageError({ code }), { code: "INTERNAL_ERROR", message: "操作未完成，请重试" });
  }
});
