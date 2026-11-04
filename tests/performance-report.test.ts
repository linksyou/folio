import assert from "node:assert/strict";
import { test } from "node:test";
import { TimingLog, type TimingEvent } from "../src/shared/diagnostics.js";
import { aggregatePerformance, summarizePerformance, type PerformanceTrace } from "../src/shared/performance-report.js";

function event(layer: TimingEvent["layer"], stage: string, atMs: number, values?: TimingEvent["values"], identity: Partial<TimingEvent> = {}): TimingEvent {
  return { layer, stage, atMs, jobId: "page-job", clockId: `${layer}-clock`, logId: `${layer}-log`, sequence: 1, values, ...identity };
}
const counts = { blocks: 2, completed: 2, skipped: 0, failed: 0, pending: 0, invalidated: 0 };
function fixture(): PerformanceTrace {
  return { version: 1, conditions: { scenarioId: "article", source: "mock", connection: "cold", cache: "miss" },
    page: [
      event("page", "session.start", 100),
      event("page", "extraction.end", 102, { blocks: 2, durationMs: 2 }),
      event("page", "reading.started", 102, { ...counts, completed: 0, pending: 2, epoch: 1, fromScroll: false }),
      event("page", "dom.firstVisible", 140, { sinceSessionMs: 40 }),
      event("page", "reading.firstVisible", 140, { epoch: 1, durationMs: 38 }),
      event("page", "reading.completed", 200, { ...counts, epoch: 1, durationMs: 98 }),
      event("page", "session.end", 205, { ...counts, durationMs: 105, success: true, cancelled: false }),
    ], background: [], host: [] };
}
function addBatch(trace: PerformanceTrace, batchId: string, providerBatch = "shared-provider") {
  trace.page!.push(event("page", "batch.send", 103, { blocks: 1 }, { batchId }));
  trace.background!.push(event("background", "reuse.link", 5000, undefined, {
    batchId, providerJobId: "provider-job", providerBatchId: providerBatch,
  }), event("background", "reuse.end", 5100, { success: true, providerGroups: 1 }, { batchId }));
}
function addProvider(trace: PerformanceTrace) {
  const id = { jobId: "provider-job", batchId: "shared-provider" };
  trace.host!.push(event("host", "queue.enter", 90000, { blocks: 1 }, id),
    event("host", "queue.leave", 90010, { waitMs: 10 }, id),
    event("host", "provider.start", 90012, undefined, id),
    event("host", "request.dispatch", 90014, undefined, id),
    event("host", "request.headers", 90030, undefined, id),
    event("host", "first.delta", 90040, undefined, id),
    event("host", "provider.firstPreview", 90045, undefined, id),
    event("host", "batch.end", 90090, { completed: true, cancelled: false }, id));
}

test("durations stay in their own clock, including linked provider jobs", () => {
  const trace = fixture(); addBatch(trace, "one"); addProvider(trace);
  const report = summarizePerformance(trace);
  assert.equal(report.metrics.firstVisible.ms, 40);
  assert.equal(report.metrics.firstScreen.ms, 98);
  assert.equal(report.metrics.wholePage.ms, 105);
  assert.equal(report.providers[0]!.dispatchToHeaders.ms, 16);
  assert.equal(report.providers[0]!.providerToPreview.ms, 33);
  assert.equal(report.coverage.totalRequests, 1);
});

test("failed and interrupted cohorts are censored, not successful zero-duration samples", () => {
  for (const interrupted of [false, true]) {
    const trace = fixture(), end = trace.page!.find((e) => e.stage === "reading.completed")!;
    if (interrupted) end.stage = "reading.interrupted";
    else end.values!.failed = 1;
    const report = summarizePerformance(trace);
    assert.equal(report.metrics.firstScreen.status, "censored");
    assert.equal(report.metrics.firstScreen.ms, null);
    assert.equal(report.metrics.firstScreen.observedMs, 98);
  }
});

test("missing start, terminal, and empty cohorts remain unknown", () => {
  const trace = fixture();
  trace.page = trace.page!.filter((e) => e.stage !== "session.end" && e.stage !== "dom.firstVisible");
  trace.page.find((e) => e.stage === "reading.started")!.values!.blocks = 0;
  const report = summarizePerformance(trace);
  assert.equal(report.metrics.wholePage.status, "unknown");
  assert.equal(report.metrics.firstVisible.ms, null);
  assert.equal(report.metrics.firstScreen.status, "unknown");
  trace.page = trace.page.filter((e) => e.stage !== "session.start");
  assert.equal(summarizePerformance(trace, { jobId: "page-job" }).metrics.wholePage.status, "unknown");
});

test("cancelled initial passes retain observation but not whole-page success", () => {
  const trace = fixture(), end = trace.page!.find((e) => e.stage === "session.end")!;
  end.values!.cancelled = true; end.values!.success = false;
  assert.deepEqual(summarizePerformance(trace).metrics.wholePage, { status: "censored", ms: null, reason: "cancelled or interrupted", observedMs: 105 });
});

test("cache-only zero requests require explicit successful reuse completion", () => {
  const trace = fixture();
  trace.page!.push(event("page", "batch.send", 103, undefined, { batchId: "cached" }));
  let report = summarizePerformance(trace);
  assert.equal(report.coverage.totalRequests, null);
  assert.equal(report.coverage.cacheOnlyBatches, 0);
  trace.background!.push(event("background", "reuse.end", 1000, { success: true, providerGroups: 0 }, { batchId: "cached" }));
  report = summarizePerformance(trace);
  assert.equal(report.coverage.cacheOnlyBatches, 1);
  assert.equal(report.coverage.totalRequests, 0);
  assert.equal(report.conditions.cache, "miss"); // labels are declared conditions, never guessed from event count
});

test("shared provider groups are counted once, with explicit page-batch links", () => {
  const trace = fixture(); addBatch(trace, "one"); addBatch(trace, "two"); addProvider(trace);
  const report = summarizePerformance(trace);
  assert.equal(report.providers.length, 1);
  assert.equal(report.providers[0]!.shared, true);
  assert.equal(report.coverage.totalRequests, 1);
  trace.host = [];
  assert.equal(summarizePerformance(trace).coverage.totalRequests, null);
});

test("truncated and legacy logs cannot claim complete request coverage", () => {
  const trace = fixture();
  for (const e of trace.page!) e.sequence = 2;
  assert.deepEqual(summarizePerformance(trace).coverage.truncatedLogs, ["page-log"]);
  assert.equal(summarizePerformance(trace).coverage.totalRequests, null);
  for (const e of trace.page!) { delete e.clockId; delete e.logId; delete e.sequence; }
  assert.equal(summarizePerformance(trace).coverage.legacyClocks, true);
  assert.equal(summarizePerformance(trace).metrics.firstVisible.ms, 40); // explicit same-layer duration still usable
});

test("provider clock resets and wall-clock reversal never yield latency success", () => {
  const trace = fixture(); addBatch(trace, "one"); addProvider(trace);
  trace.host!.find((e) => e.stage === "request.headers")!.clockId = "host-restarted";
  trace.page!.push(event("page", "ui.firstVisible", 140, { clockValid: false, clickToVisibleMs: -50 }));
  const report = summarizePerformance(trace);
  assert.equal(report.providers[0]!.dispatchToHeaders.status, "unknown");
  assert.equal(report.metrics.clickToFirstVisible.status, "unknown");
  assert.equal(report.coverage.totalRequests, null);
});

test("reading epochs retain separate scroll starts and deferred first-visible durations", () => {
  const trace = fixture();
  trace.page!.push(event("page", "reading.started", 300, { ...counts, epoch: 2, fromScroll: true, captureDelayMs: 40 }),
    event("page", "reading.firstVisible", 301, { epoch: 2, durationMs: 15, observedBeforeCapture: true }),
    event("page", "reading.completed", 360, { ...counts, epoch: 2, durationMs: 100 }));
  const report = summarizePerformance(trace);
  assert.equal(report.reading[1]!.firstVisible.ms, 15);
  assert.equal(report.reading[1]!.completion.ms, 100);
  assert.equal(report.metrics.firstScreen.ms, 98);
});

test("percentiles include sample counts and do not mix cold/warm conditions or missing values", () => {
  const a = summarizePerformance(fixture()), b = summarizePerformance(fixture()), c = summarizePerformance(fixture(), { conditions: { connection: "warm" } });
  a.metrics.firstVisible.ms = 10; b.metrics.firstVisible.ms = 20;
  b.metrics.firstScreen = { status: "censored", ms: null };
  const result = aggregatePerformance([a, b, c]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0]!.metrics.firstVisible, { n: 2, total: 2, unknown: 0, censored: 0, p50: 10, p95: 20 });
  assert.equal(result[0]!.metrics.firstScreen!.n, 1);
});

test("multiple jobs are explicitly selected, not ordered using incomparable clocks", () => {
  const trace = fixture(); trace.page!.push(event("page", "session.start", 1, undefined, { jobId: "another", clockId: "new-page" }));
  assert.throws(() => summarizePerformance(trace), /Specify --job/);
  assert.equal(summarizePerformance(trace, { jobId: "page-job" }).metrics.firstVisible.ms, 40);
});

test("bounded timing logs share the realm clock but expose their own truncation", () => {
  const a = new TimingLog("page", 2), b = new TimingLog("page");
  a.mark("one"); a.mark("two"); a.mark("three"); b.mark("other");
  assert.deepEqual(a.read().map((e) => e.sequence), [2, 3]);
  assert.equal(a.read()[0]!.clockId, b.read()[0]!.clockId);
  assert.notEqual(a.read()[0]!.logId, b.read()[0]!.logId);
});


test("missing scroll epochs remain in aggregate denominators", () => {
  const a = fixture(), b = fixture();
  a.page!.push(event("page", "reading.started", 300, { ...counts, epoch: 2, fromScroll: true }),
    event("page", "reading.completed", 350, { ...counts, epoch: 2, durationMs: 50 }));
  const group = aggregatePerformance([summarizePerformance(a), summarizePerformance(b)])[0]!;
  assert.deepEqual(group.scrolling[0]!.completion, { n: 1, total: 2, unknown: 1, censored: 0, p50: 50, p95: 50 });
});

test("mock harness counts do not manufacture production request coverage", () => {
  const trace = fixture(); trace.providerCalls = 4;
  const report = summarizePerformance(trace);
  assert.equal(report.harnessProviderCalls, 4);
  assert.equal(report.coverage.totalRequests, null);
  assert.equal(report.coverage.complete, false);
});
