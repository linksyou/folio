import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { TimingEvent } from "../src/shared/diagnostics.js";
import { summarizePerformance } from "../scripts/analyze-performance.js";

const event = (layer: TimingEvent["layer"], stage: string, atMs: number,
  values?: TimingEvent["values"], batchId?: string, jobId = "job"): TimingEvent => ({ layer, stage, atMs, values, batchId, jobId });
const sent = (id: string, atMs = 2) => event("page", "batch.send", atMs, { blocks: 1 }, id);
const session = () => event("page", "session.start", 1);
const batch = (id: string, usage?: TimingEvent["values"]): TimingEvent[] => [
  event("host", "queue.enter", 10_000, { blocks: 1, characters: 42 }, id),
  event("host", "queue.leave", 10_020, undefined, id),
  event("host", "provider.start", 10_025, undefined, id),
  event("host", "auth.start", 10_026, undefined, id),
  event("host", "auth.end", 10_027, undefined, id),
  event("host", "request.dispatch", 10_030, undefined, id),
  event("host", "request.headers", 10_330, undefined, id),
  event("host", "first.delta", 10_400, undefined, id),
  event("host", "provider.firstPreview", 10_410, undefined, id),
  ...(usage ? [event("host", "terminal", 10_800, usage, id)] : []),
  event("host", "batch.end", 10_805, { completed: Boolean(usage), cancelled: !usage }, id),
];
const linked = (pageBatchId: string, providerBatchId: string, providerJobId = "provider-job", jobId = "job"): TimingEvent => ({
  ...event("background", "reuse.link", 100, undefined, pageBatchId, jobId), providerJobId, providerBatchId,
});
const reused = (pageBatchId: string, providerGroups: number | undefined, success = true): TimingEvent =>
  event("background", "reuse.end", 900, { success, ...(providerGroups === undefined ? {} : { providerGroups }) }, pageBatchId);
const providerBatch = (id: string, usage?: TimingEvent["values"], providerJobId = "provider-job") =>
  batch(id, usage).map((event) => ({ ...event, jobId: providerJobId }));

test("complete Host coverage separates dispatched attempts from cancelled requests with unknown usage", () => {
  const report = summarizePerformance({ page: [session(), sent("a"), sent("b")], host: [
    ...batch("a", { inputTokens: 100, outputTokens: 30, reasoningTokens: 5, cachedTokens: 20 }), ...batch("b"),
  ] });
  assert.equal(report.hostCoverageComplete, true);
  assert.equal(report.observedDispatchedRequests, 2);
  assert.equal(report.dispatchedRequests, 2);
  assert.equal(report.completedBatches, 1);
  assert.equal(report.cancelledBatches, 1);
  assert.equal(report.usage.knownInput, 100);
  assert.equal(report.usage.knownOutput, 30, "reasoning is a subset, not added to output");
  assert.equal(report.usage.knownCached, 20);
  assert.equal(report.usage.dispatchedWithoutCompleteUsage, 1);
  assert.equal(report.usage.completeForJob, false);
});

test("missing early Host batches expose observed counts without claiming complete request totals", () => {
  const report = summarizePerformance({ page: [session(), sent("first"), sent("scroll")],
    host: batch("scroll", { inputTokens: 90, outputTokens: 15 }) });
  assert.equal(report.hostCoverageComplete, false);
  assert.equal(report.observedDispatchedRequests, 1);
  assert.equal(report.dispatchedRequests, undefined);
  assert.equal(report.batches.find(({ batchId }) => batchId === "first")?.dispatched, undefined);
  assert.equal(report.usage.observedDispatchedWithoutCompleteUsage, 0);
  assert.equal(report.usage.dispatchedWithoutCompleteUsage, undefined);
  assert.equal(report.usage.completeForObservedRequests, true);
  assert.equal(report.usage.completeForJob, false);
  assert.equal(report.usage.knownReasoning, undefined, "missing details are not zero reasoning tokens");
});

test("empty Host diagnostics do not turn missing requests or usage into zero totals", () => {
  const report = summarizePerformance({ page: [session(), sent("missing")], host: [] });
  const serialized = JSON.parse(JSON.stringify(report));
  assert.equal(report.observedDispatchedRequests, 0);
  assert.equal(report.hostCoverageComplete, false);
  assert.equal("dispatchedRequests" in serialized, false);
  assert.equal("knownInput" in serialized.usage, false);
  assert.equal("knownOutput" in serialized.usage, false);
  assert.equal(report.usage.completeForJob, false);
  assert.equal(report.usage.completeForObservedRequests, false);
});

test("partial and explicit zero usage remain distinct from invalid or missing fields", () => {
  const report = summarizePerformance({ page: [session(), sent("partial")], host: batch("partial", {
    inputTokens: 0, outputTokens: -1, reasoningTokens: Number.NaN, cachedTokens: 0,
  }) });
  assert.equal(report.usage.knownInput, 0);
  assert.equal(report.usage.knownCached, 0);
  assert.equal(report.usage.knownOutput, undefined);
  assert.equal(report.usage.knownReasoning, undefined);
  assert.equal(report.usage.requestsWithCompleteUsage, 0);
  assert.equal(report.usage.dispatchedWithoutCompleteUsage, 1);
});

test("stage deltas stay within Host clocks and click completion stays within page clocks", () => {
  const report = summarizePerformance({ page: [session(), sent("a"),
    event("page", "ui.commandReceived", 0, { clickToCommandMs: 75 }),
    event("page", "ui.firstVisible", 420, { clickToVisibleMs: 495 }),
    event("page", "reading.started", 10, { epoch: 1, blocks: 1, fromScroll: false }),
    event("page", "reading.completed", 900, { epoch: 1, blocks: 1, durationMs: 890, failed: 0, invalidated: 0, pending: 0 }),
  ], host: batch("a", { inputTokens: 10, outputTokens: 5 }) });
  assert.equal(report.clickToFirstVisibleMs, 495);
  assert.equal(report.reading[0].clickToCompleteMs, 975);
  assert.equal(report.batches[0].queueMs, 20);
  assert.equal(report.batches[0].localBeforeProviderMs, 5);
  assert.equal(report.batches[0].authMs, 1);
  assert.equal(report.batches[0].dispatchToHeadersMs, 300);
  assert.equal(report.batches[0].headersToDeltaMs, 70);
  assert.equal(report.batches[0].deltaToPreviewMs, 10);
  assert.equal(report.usage.completeForJob, true);
});

test("interrupted, failed, invalidated and empty cohorts cannot report successful full-screen latency", () => {
  const page = [session(), event("page", "ui.commandReceived", 0, { clickToCommandMs: 10 })];
  for (const [index, ending] of [
    { stage: "reading.interrupted", failed: 0, invalidated: 0, pending: 1, blocks: 1 },
    { stage: "reading.completed", failed: 1, invalidated: 0, pending: 0, blocks: 1 },
    { stage: "reading.completed", failed: 0, invalidated: 1, pending: 0, blocks: 1 },
    { stage: "reading.completed", failed: 0, invalidated: 0, pending: 0, blocks: 0 },
  ].entries()) {
    page.push(event("page", "reading.started", 10 + index * 100, { epoch: index, blocks: ending.blocks, fromScroll: false }));
    const { stage, ...values } = ending;
    page.push(event("page", stage, 90 + index * 100, { ...values, epoch: index, durationMs: 80 }));
  }
  const report = summarizePerformance({ page });
  assert.equal(report.reading[0].interrupted, true);
  assert.ok(report.reading.every((reading) => !reading.completed && reading.clickToCompleteMs === undefined));
});

test("truncated page identities and reversed timestamps cannot establish complete or negative metrics", () => {
  const host = batch("a", { inputTokens: 10, outputTokens: 5 });
  host.find(({ stage }) => stage === "auth.end")!.atMs = 10_000;
  const report = summarizePerformance({ page: [sent("a")], host }, "job");
  assert.equal(report.hostCoverageComplete, false);
  assert.equal(report.batches[0].authMs, undefined);
  assert.throws(() => summarizePerformance({ host }), /No page session found/);
  const missingPageBatch = summarizePerformance({ page: [session()], host });
  assert.equal(missingPageBatch.hostCoverageComplete, false, "Host-only batches reveal missing page records");
});

test("latest page session is selected without mixing earlier jobs", () => {
  const report = summarizePerformance({ page: [session(), event("page", "session.start", 100, undefined, undefined, "new-job")],
    host: batch("old", { inputTokens: 100, outputTokens: 100 }) });
  assert.equal(report.jobId, "new-job");
  assert.equal(report.dispatchedRequests, 0, "a complete cached/no-request session has an actual zero count");
  assert.equal(report.usage.knownInput, undefined);
});

test("a successful zero-provider reuse batch proves cache-only completion without Host events", () => {
  const report = summarizePerformance({ page: [session(), sent("cached")], background: [reused("cached", 0)], host: [] });
  assert.equal(report.hostCoverageComplete, true);
  assert.equal(report.dispatchedRequests, 0);
  assert.equal(report.cacheOnlyBatches, 1);
  assert.equal(report.batches.length, 0, "Cached page batches are not invented model requests");
  assert.equal(report.pageBatches[0].cacheOnly, true);
  assert.equal(report.usage.completeForJob, true);
  assert.equal(report.usage.knownInput, undefined, "No provider token report was returned");
});

test("mixed cache and model batches correlate internal Host IDs to the selected page", () => {
  const report = summarizePerformance({ page: [session(), sent("cached"), sent("generated")],
    background: [reused("cached", 0), linked("generated", "native-a"), reused("generated", 1)],
    host: providerBatch("native-a", { inputTokens: 20, outputTokens: 9 }),
  });
  assert.equal(report.dispatchedRequests, 1);
  assert.equal(report.cacheOnlyBatches, 1);
  assert.equal(report.usage.knownInput, 20);
  assert.equal(report.usage.knownOutput, 9);
  assert.equal(report.usage.completeForJob, true);
  assert.deepEqual(report.batches[0].pageBatchIds, ["generated"]);
  assert.equal(report.batches[0].providerJobId, "provider-job");
});

test("multiple page batches sharing one provider group count its requests and tokens once", () => {
  const report = summarizePerformance({ page: [session(), sent("one"), sent("two")], background: [
    linked("one", "native"), linked("two", "native"), linked("one", "native"), reused("one", 1), reused("two", 1),
  ], host: providerBatch("native", { inputTokens: 40, outputTokens: 11, reasoningTokens: 0, cachedTokens: 0 }) });
  assert.equal(report.dispatchedRequests, 1);
  assert.equal(report.sharedProviderBatches, 1);
  assert.equal(report.completedBatches, 1);
  assert.equal(report.usage.knownInput, 40);
  assert.equal(report.usage.knownOutput, 11);
  assert.equal(report.batches[0].observedConsumerBatches, 2);
  assert.deepEqual(report.batches[0].pageBatchIds, ["one", "two"]);
});

test("shared work across page jobs remains one whole provider usage without including unrelated groups", () => {
  const report = summarizePerformance({ page: [session(), sent("one")], background: [
    linked("one", "native"), linked("other", "native", "provider-job", "other-page-job"), reused("one", 1),
  ], host: [
    ...providerBatch("native", { inputTokens: 40, outputTokens: 11 }),
    ...providerBatch("unrelated", { inputTokens: 900, outputTokens: 900 }, "other-provider-job"),
  ] });
  assert.equal(report.dispatchedRequests, 1);
  assert.equal(report.sharedProviderBatches, 1);
  assert.equal(report.usage.knownInput, 40);
});

test("missing reuse links, group counts or Host events cannot masquerade as cache-only zero", () => {
  const cases = [
    { background: [reused("one", 1)], host: providerBatch("native", { inputTokens: 10, outputTokens: 2 }) },
    { background: [reused("one", undefined)], host: [] },
    { background: [linked("one", "native"), reused("one", 1)], host: [] },
    { background: [linked("one", "native"), reused("one", 2)], host: providerBatch("native", { inputTokens: 10, outputTokens: 2 }) },
    { background: [linked("one", "native")], host: providerBatch("native", { inputTokens: 10, outputTokens: 2 }) },
    { background: [reused("one", 0, false)], host: [] },
  ];
  for (const fixture of cases) {
    const report = summarizePerformance({ page: [session(), sent("one")], ...fixture });
    assert.equal(report.hostCoverageComplete, false);
    assert.equal(report.dispatchedRequests, undefined);
    assert.equal(report.cacheOnlyBatches, 0);
    assert.equal(report.unresolvedPageBatches, 1);
    assert.equal(report.usage.completeForJob, false);
  }
});

test("a new reuse count can coexist with old direct Host batches in the same report", () => {
  const report = summarizePerformance({ page: [session(), sent("old"), sent("new")],
    background: [linked("new", "native"), reused("new", 1)],
    host: [...batch("old", { inputTokens: 7, outputTokens: 2 }), ...providerBatch("native", { inputTokens: 13, outputTokens: 3 })],
  });
  assert.equal(report.dispatchedRequests, 2);
  assert.equal(report.usage.knownInput, 20);
  assert.equal(report.usage.knownOutput, 5);
  assert.equal(report.usage.completeForJob, true);
});

test("reading reports preserve explicitly skipped source-language blocks", () => {
  const report = summarizePerformance({ page: [session(),
    event("page", "reading.started", 2, { epoch: 1, blocks: 3, skipped: 1 }),
    event("page", "reading.completed", 100, { epoch: 1, blocks: 3, skipped: 2, durationMs: 98, failed: 0, invalidated: 0, pending: 0 }),
  ] });
  assert.equal(report.reading[0].skipped, 2);
});

test("CLI writes the same partial-coverage report it prints without inventing omitted totals", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "owt-performance-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "trace.json");
  const output = join(directory, "report.json");
  await writeFile(input, JSON.stringify({ page: [session(), sent("missing"), sent("observed")], host: batch("observed", { inputTokens: 12, outputTokens: 4 }) }));
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/analyze-performance.ts", input, output, "job"]);
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(JSON.parse(result.stdout), report);
  assert.equal(report.observedDispatchedRequests, 1);
  assert.equal("dispatchedRequests" in report, false);
  assert.equal(report.usage.completeForJob, false);
});
