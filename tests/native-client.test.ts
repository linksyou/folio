import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { NativeClient } from "../src/extension/native-client.js";
import type { NativeMessage, NativeRequest } from "../src/shared/protocol.js";

test("native progress reaches only its pending request and does not settle the final result", async (t) => {
  const originalChrome = globalThis.chrome;
  const originalSetTimeout = globalThis.setTimeout;
  let receive!: (message: NativeMessage) => void;
  let disconnect!: () => void;
  const posted: NativeRequest[] = [];
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { runtime: { connectNative: () => ({
      postMessage: (message: NativeRequest) => posted.push(message),
      onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
      onDisconnect: { addListener: (listener: typeof disconnect) => { disconnect = listener; } },
      disconnect: () => disconnect(),
    }) } },
  });
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = originalSetTimeout(...args);
    timer.unref();
    return timer;
  }) as typeof setTimeout;
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
  });
  const client = new NativeClient();
  const progress: unknown[] = [];
  let settled = false;
  const pending = client.request({
    type: "translate", jobId: "job", batchId: "batch", settingsRevision: "settings",
    blocks: [{ id: "a", text: "Hello" }],
  }, (translations) => progress.push(translations)).then((result) => { settled = true; return result; });
  const id = posted[0].id;
  receive({ id: "unknown", event: "translation.progress", translations: [{ id: "a", text: "ignored" }] });
  receive({ id, event: "translation.progress", translations: [{ id: "a", text: "你" }] });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(progress, [[{ id: "a", text: "你" }]]);
  receive({ id, ok: true, result: [{ id: "a", text: "你好" }] });
  assert.deepEqual(await pending, [{ id: "a", text: "你好" }]);
  receive({ id, event: "translation.progress", translations: [{ id: "a", text: "late" }] });
  assert.equal(progress.length, 1);
});

test("native port survives a reading pause, closes when idle, and reconnects on demand", async (t) => {
  const originalChrome = globalThis.chrome;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let connections = 0;
  let disconnections = 0;
  let receive!: (message: NativeMessage) => void;
  let last!: NativeRequest;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { runtime: { connectNative: () => {
      connections++;
      let disconnected!: () => void;
      return {
        postMessage: (message: NativeRequest) => { last = message; },
        onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
        onDisconnect: { addListener: (listener: typeof disconnected) => { disconnected = listener; } },
        disconnect: () => { disconnections++; disconnected(); },
      };
    } } },
  });
  t.after(() => {
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
  });
  const client = new NativeClient();
  const request = async () => {
    const result = client.request({ type: "status" });
    receive({ id: last.id, ok: true, result: {} });
    await result;
  };
  await request();
  t.mock.timers.tick(5_500);
  await request();
  assert.equal(connections, 1, "A pause longer than the former five-second limit keeps the same host");
  assert.equal(disconnections, 0);
  t.mock.timers.tick(59_999);
  assert.equal(disconnections, 0);
  t.mock.timers.tick(1);
  assert.equal(disconnections, 1, "The helper still shuts down after a bounded idle period");
  await request();
  assert.equal(connections, 2);
});

function timeoutHarness(t: TestContext) {
  const originalChrome = globalThis.chrome;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const posted: NativeRequest[] = [];
  let receive!: (message: NativeMessage) => void;
  let connections = 0;
  let disconnections = 0;
  let failCancellation = false;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { runtime: { connectNative: () => {
      connections++;
      let disconnected!: () => void;
      return {
        postMessage: (message: NativeRequest) => {
          posted.push(message);
          if (failCancellation && message.command.type.startsWith("translate.cancel")) {
            throw new Error("Cancellation could not be sent");
          }
        },
        onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
        onDisconnect: { addListener: (listener: typeof disconnected) => { disconnected = listener; } },
        disconnect: () => { disconnections++; disconnected(); },
      };
    } } },
  });
  t.after(() => {
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
  });
  return {
    client: new NativeClient(),
    posted,
    receive: (message: NativeMessage) => receive(message),
    failCancellation: () => { failCancellation = true; },
    connections: () => connections,
    disconnections: () => disconnections,
  };
}

test("a timed-out batch cancels only that batch and ignores late output while other requests finish", async (t) => {
  const harness = timeoutHarness(t);
  const progress: unknown[] = [];
  let resolved = false;
  const expired = harness.client.request({
    type: "translate", jobId: "shared-job", batchId: "expired-batch", settingsRevision: "settings",
    blocks: [{ id: "a", text: "Hello" }],
  }, (translations) => progress.push(translations)).then(() => { resolved = true; });
  const rejection = assert.rejects(expired, { code: "HOST_UNAVAILABLE" });
  const expiredId = harness.posted[0].id;
  harness.receive({ id: expiredId, event: "translation.progress", translations: [{ id: "a", text: "你" }] });

  // Advancing the fake clock preserves the production 240s deadline without
  // sleeping. A later sibling has its own deadline, even under the same job.
  t.mock.timers.tick(239_000);
  const siblingProgress: unknown[] = [];
  const sibling = harness.client.request({
    type: "translate", jobId: "shared-job", batchId: "active-batch", settingsRevision: "settings",
    blocks: [{ id: "b", text: "World" }],
  }, (translations) => siblingProgress.push(translations));
  const siblingId = harness.posted[1].id;
  const status = harness.client.request({ type: "status" });
  const statusId = harness.posted[2].id;
  t.mock.timers.tick(1_000);
  await rejection;

  const cancel = harness.posted[3];
  assert.deepEqual(cancel.command, {
    type: "translate.cancelBatch", jobId: "shared-job", batchId: "expired-batch",
  });
  assert.notEqual(cancel.id, expiredId);
  assert.equal(harness.connections(), 1);
  harness.receive({ id: cancel.id, ok: true, result: {} });
  harness.receive({ id: expiredId, event: "translation.progress", translations: [{ id: "a", text: "迟到" }] });
  harness.receive({ id: expiredId, ok: true, result: [{ id: "a", text: "迟到" }] });
  assert.equal(resolved, false);
  assert.deepEqual(progress, [[{ id: "a", text: "你" }]]);

  harness.receive({ id: siblingId, event: "translation.progress", translations: [{ id: "b", text: "世" }] });
  harness.receive({ id: statusId, ok: true, result: { connected: true } });
  harness.receive({ id: siblingId, ok: true, result: [{ id: "b", text: "世界" }] });
  assert.deepEqual(await status, { connected: true });
  assert.deepEqual(await sibling, [{ id: "b", text: "世界" }]);
  assert.deepEqual(siblingProgress, [[{ id: "b", text: "世" }]]);
  t.mock.timers.tick(59_999);
  assert.equal(harness.disconnections(), 0);
  t.mock.timers.tick(1);
  assert.equal(harness.disconnections(), 1);
  t.mock.timers.tick(240_000);
  assert.equal(harness.posted.length, 4, "Cancellation does not create a recursive timed request");
});

test("a timed-out translation without a batch cancels its job without waiting for cancellation acknowledgement", async (t) => {
  const harness = timeoutHarness(t);
  const rejection = assert.rejects(harness.client.request({
    type: "translate", jobId: "legacy-job", settingsRevision: "settings",
    blocks: [{ id: "a", text: "Hello" }],
  }), { code: "HOST_UNAVAILABLE" });
  t.mock.timers.tick(240_000);
  await rejection;
  assert.deepEqual(harness.posted[1].command, { type: "translate.cancel", jobId: "legacy-job" });
  // Never acknowledge the cancellation. It must not become orphaned pending work.
  t.mock.timers.tick(60_000);
  assert.equal(harness.disconnections(), 1);
  assert.equal(harness.posted.length, 2);
  const status = harness.client.request({ type: "status" });
  assert.equal(harness.connections(), 2, "Only a later user request reconnects the host");
  harness.receive({ id: harness.posted[2].id, ok: true, result: {} });
  await status;
});

test("connection tests and cancellation requests time out without inventing a job or sending more cancellation", async (t) => {
  for (const command of [
    { type: "connection.test" },
    { type: "translate.cancel", jobId: "job" },
    { type: "translate.cancelBatch", jobId: "job", batchId: "batch" },
  ] as const) {
    await t.test(command.type, async (t) => {
      const harness = timeoutHarness(t);
      const rejection = assert.rejects(harness.client.request(command), { code: "HOST_UNAVAILABLE" });
      t.mock.timers.tick(command.type === "connection.test" ? 240_000 : 90_000);
      await rejection;
      assert.deepEqual(harness.posted.map((message) => message.command), [command]);
      t.mock.timers.tick(60_000);
      assert.equal(harness.disconnections(), 1);
    });
  }
});

test("a failed timeout cancellation does not reject an unrelated pending request", async (t) => {
  const harness = timeoutHarness(t);
  harness.failCancellation();
  const rejection = assert.rejects(harness.client.request({
    type: "translate", jobId: "job", batchId: "batch", settingsRevision: "settings",
    blocks: [{ id: "a", text: "Hello" }],
  }), { code: "HOST_UNAVAILABLE" });
  t.mock.timers.tick(239_000);
  const status = harness.client.request({ type: "status" });
  const statusId = harness.posted[1].id;
  t.mock.timers.tick(1_000);
  await rejection;
  assert.equal(harness.posted[2].command.type, "translate.cancelBatch");
  harness.receive({ id: statusId, ok: true, result: { connected: true } });
  assert.deepEqual(await status, { connected: true });
  assert.equal(harness.connections(), 1);
  t.mock.timers.tick(60_000);
  assert.equal(harness.disconnections(), 1);
});
