import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { TimingEvent } from "../src/shared/diagnostics.js";

interface Trace { page?: TimingEvent[]; host?: TimingEvent[]; background?: TimingEvent[] }
const numeric = (event: TimingEvent | undefined, key: string): number | undefined => {
  const value = event?.values?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
};
const rounded = (value: number | undefined) => value === undefined ? undefined : Math.round(value * 10) / 10;
const duration = (events: TimingEvent[], from: string, to: string) => {
  const start = events.find((event) => event.stage === from);
  const end = events.find((event) => event.stage === to);
  const elapsed = start && end ? end.atMs - start.atMs : undefined;
  return elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0 ? rounded(elapsed) : undefined;
};

/** Summarize exported numeric diagnostics without subtracting different process clocks. */
export function summarizePerformance(trace: Trace, requestedJob?: string) {
  const pages = trace.page ?? [];
  const jobId = requestedJob ?? pages.filter((event) => event.stage === "session.start")
    .sort((a, b) => a.atMs - b.atMs).at(-1)?.jobId;
  if (!jobId) throw new Error("No page session found; export again before the bounded log expires.");
  const page = pages.filter((event) => event.jobId === jobId).sort((a, b) => a.atMs - b.atMs);
  const allHost = trace.host ?? [];
  const background = (trace.background ?? []).filter((event) => event.jobId === jobId);
  const commands = page.find((event) => event.stage === "ui.commandReceived");
  const clickToCommand = numeric(commands, "clickToCommandMs");
  const identity = (owner: string, batchId: string) => JSON.stringify([owner, batchId]);
  const pageBatchIds = new Set(page.filter((event) => event.stage === "batch.send").flatMap((event) => event.batchId ? [event.batchId] : []));
  const providers = new Map<string, { jobId: string; batchId: string; pageBatchIds: Set<string> }>();
  const addProvider = (owner: string, batchId: string, pageBatchId?: string) => {
    const key = identity(owner, batchId);
    let provider = providers.get(key);
    if (!provider) { provider = { jobId: owner, batchId, pageBatchIds: new Set() }; providers.set(key, provider); }
    if (pageBatchId) provider.pageBatchIds.add(pageBatchId);
    return key;
  };
  const hostCovered = (key: string) => allHost.some((event) => event.jobId && event.batchId &&
    identity(event.jobId, event.batchId) === key && event.stage === "queue.enter");
  const directHost = allHost.filter((event) => event.jobId === jobId);
  const allPageBatchIds = new Set([...page, ...background, ...directHost].flatMap((event) => event.batchId ? [event.batchId] : []));
  const pageBatches = [...allPageBatchIds].map((batchId) => {
    const events = background.filter((event) => event.batchId === batchId);
    const links = events.filter((event) => event.stage === "reuse.link" && event.providerJobId && event.providerBatchId);
    const end = events.filter((event) => event.stage === "reuse.end").sort((a, b) => a.atMs - b.atMs).at(-1);
    const expected = numeric(end, "providerGroups");
    const expectedGroups = expected !== undefined && Number.isInteger(expected) ? expected : undefined;
    const providerKeys = new Set(links.map((event) => addProvider(event.providerJobId!, event.providerBatchId!, batchId)));
    const reused = links.length > 0 || Boolean(end);
    const cacheOnly = end?.values?.success === true && expectedGroups === 0 && providerKeys.size === 0;
    if (!reused) providerKeys.add(addProvider(jobId, batchId, batchId));
    const providerCoverageComplete = reused
      ? cacheOnly || (expectedGroups !== undefined && expectedGroups > 0 && expectedGroups === providerKeys.size && [...providerKeys].every(hostCovered))
      : [...providerKeys].every(hostCovered);
    return {
      batchId, cacheOnly, reused, expectedProviderGroups: expectedGroups,
      observedProviderGroups: reused ? providerKeys.size : undefined,
      providerCoverageComplete: pageBatchIds.has(batchId) && providerCoverageComplete,
      success: end?.values?.success === true,
    };
  });
  // Include direct Host-only records so truncated page logs cannot claim complete coverage.
  for (const event of directHost) if (event.batchId) addProvider(jobId, event.batchId);
  const batches = [...providers.values()].map((provider) => {
    const { batchId } = provider;
    const events = allHost.filter((event) => event.jobId === provider.jobId && event.batchId === batchId).sort((a, b) => a.atMs - b.atMs);
    const terminal = events.filter((event) => event.stage === "terminal");
    const end = events.find((event) => event.stage === "batch.end");
    const knownConsumers = new Set((trace.background ?? []).filter((event) => event.stage === "reuse.link"
      && event.providerJobId === provider.jobId && event.providerBatchId === batchId && event.jobId && event.batchId)
      .map((event) => identity(event.jobId!, event.batchId!)));
    return {
      batchId, providerJobId: provider.jobId, pageBatchIds: [...provider.pageBatchIds],
      shared: knownConsumers.size > 1, observedConsumerBatches: knownConsumers.size || undefined,
      blocks: numeric(events.find((event) => event.stage === "queue.enter"), "blocks"),
      characters: numeric(events.find((event) => event.stage === "queue.enter"), "characters"),
      dispatched: events.some((event) => event.stage === "queue.enter")
        ? events.filter((event) => event.stage === "request.dispatch").length : undefined,
      observedDispatched: events.filter((event) => event.stage === "request.dispatch").length,
      completed: end?.values?.completed === true, cancelled: end?.values?.cancelled === true,
      timedOut: end?.values?.timedOut === true,
      queueMs: duration(events, "queue.enter", "queue.leave"),
      localBeforeProviderMs: duration(events, "queue.leave", "provider.start"),
      authMs: duration(events, "auth.start", "auth.end"),
      dispatchToHeadersMs: duration(events, "request.dispatch", "request.headers"),
      headersToDeltaMs: duration(events, "request.headers", "first.delta"),
      deltaToPreviewMs: duration(events, "first.delta", "provider.firstPreview"),
      dispatchToTerminalMs: duration(events, "request.dispatch", "terminal"),
      terminalUsage: terminal.map((event) => ({
        input: numeric(event, "inputTokens"), output: numeric(event, "outputTokens"),
        reasoning: numeric(event, "reasoningTokens"), cached: numeric(event, "cachedTokens"),
      })),
    };
  });
  const requests = batches.reduce((sum, batch) => sum + batch.observedDispatched, 0);
  const usages = batches.flatMap((batch) => batch.terminalUsage);
  const completeUsage = usages.filter((usage) => usage.input !== undefined && usage.output !== undefined);
  const hostCoverageComplete = page.some((event) => event.stage === "session.start")
    && pageBatches.every((batch) => batch.providerCoverageComplete)
    && directHost.every((event) => !event.batchId || pageBatchIds.has(event.batchId));
  const observedUsageComplete = requests > 0 && completeUsage.length === requests;
  const sumKnown = (field: keyof typeof usages[number]) => {
    const values = usages.flatMap((usage) => usage[field] === undefined ? [] : [usage[field]!]);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
  };
  const reading = page.filter((event) => event.stage === "reading.started").map((start) => {
    const epoch = numeric(start, "epoch");
    const events = page.filter((event) => event.stage.startsWith("reading.") && numeric(event, "epoch") === epoch);
    const first = events.find((event) => event.stage === "reading.firstVisible");
    const end = events.find((event) => event.stage === "reading.completed" || event.stage === "reading.interrupted");
    const completed = end?.stage === "reading.completed";
    const successful = completed && (numeric(start, "blocks") ?? 0) > 0
      && numeric(end, "failed") === 0 && numeric(end, "invalidated") === 0;
    return {
      epoch, fromScroll: start.values?.fromScroll === true,
      blocks: numeric(start, "blocks"), alreadyCompleted: numeric(start, "alreadyCompleted"),
      availableAtStart: numeric(start, "availableAtStart"),
      availableAtCapture: numeric(start, "availableAtCapture"), captureDelayMs: rounded(numeric(start, "captureDelayMs")),
      firstNewVisibleMs: rounded(numeric(first, "durationMs")),
      firstObservedBeforeCapture: first?.values?.observedBeforeCapture === true,
      completed: successful, interrupted: end?.stage === "reading.interrupted",
      settleMs: rounded(numeric(end, "durationMs")),
      failed: numeric(end, "failed"), invalidated: numeric(end, "invalidated"), pending: numeric(end, "pending"),
      skipped: numeric(end, "skipped") ?? numeric(start, "skipped"),
      clickToCompleteMs: successful && start.values?.fromScroll === false && commands && clickToCommand !== undefined
        && end!.atMs >= commands.atMs
        ? rounded(clickToCommand + end!.atMs - commands.atMs) : undefined,
    };
  });
  return {
    jobId,
    boundaries: {
      visible: "Nonempty translation in viewport DOM; not a browser paint timestamp.",
      reading: "Fixed source ranges captured at session/scroll start; interrupted or failed cohorts are not full-screen success.",
      request: "Unique provider groups linked to page batches, with fetch attempts counted once even when shared. Pure cache requires successful reuse.end with providerGroups=0; missing links or Host logs leave totals unknown.",
      usage: "Only returned terminal token fields, once per provider group; shared group usage is not apportioned across pages. Reasoning/cached are subsets, not extra tokens. Missing usage is unknown.",
      clocks: "Durations stay within their layer. Click-to-page uses same-machine Date.now and may be affected by clock changes.",
    },
    clickToFirstVisibleMs: numeric(page.find((event) => event.stage === "ui.firstVisible"), "clickToVisibleMs"),
    extractionMs: rounded(numeric(page.find((event) => event.stage === "extraction.end"), "durationMs")),
    initialBlocks: numeric(page.find((event) => event.stage === "extraction.end"), "blocks"),
    hostCoverageComplete, observedDispatchedRequests: requests,
    dispatchedRequests: hostCoverageComplete ? requests : undefined,
    cacheOnlyBatches: pageBatches.filter((batch) => batch.cacheOnly).length,
    sharedProviderBatches: batches.filter((batch) => batch.shared).length,
    unresolvedPageBatches: pageBatches.filter((batch) => !batch.providerCoverageComplete).length,
    completedBatches: batches.filter((batch) => batch.completed).length,
    cancelledBatches: batches.filter((batch) => batch.cancelled).length,
    usage: {
      knownInput: sumKnown("input"),
      knownOutput: sumKnown("output"),
      knownReasoning: sumKnown("reasoning"),
      knownCached: sumKnown("cached"),
      requestsWithCompleteUsage: completeUsage.length,
      observedDispatchedWithoutCompleteUsage: Math.max(0, requests - completeUsage.length),
      dispatchedWithoutCompleteUsage: hostCoverageComplete ? Math.max(0, requests - completeUsage.length) : undefined,
      completeForObservedRequests: observedUsageComplete,
      completeForJob: hostCoverageComplete && (requests === 0 || observedUsageComplete),
    },
    reading, pageBatches, batches,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , input, output, jobId] = process.argv;
  if (!input) throw new Error("Usage: npx tsx scripts/analyze-performance.ts input.json [output.json] [jobId]");
  const report = summarizePerformance(JSON.parse(await readFile(input, "utf8")), jobId);
  const json = JSON.stringify(report, null, 2);
  if (output) await writeFile(output, `${json}\n`);
  console.log(json);
}
