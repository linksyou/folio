import type { TimingEvent } from "./diagnostics.js";

export interface Conditions {
  scenarioId?: string;
  source?: "mock" | "live" | "unknown";
  connection?: "cold" | "warm" | "unknown";
  cache?: "miss" | "hit" | "partial" | "disabled" | "unknown";
}
export interface PerformanceTrace {
  version?: number;
  page?: TimingEvent[];
  background?: TimingEvent[];
  host?: TimingEvent[];
  conditions?: Conditions;
  /** Explicit count supplied by the isolated browser harness, not inferred network usage. */
  providerCalls?: number;
}
export interface Metric {
  status: "ok" | "unknown" | "censored";
  ms: number | null;
  reason?: string;
  observedMs?: number;
}
const number = (event: TimingEvent | undefined, key: string): number | undefined => {
  const value = event?.values?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
};
const round = (value: number) => Math.round(value * 10) / 10;
const unknown = (reason: string): Metric => ({ status: "unknown", ms: null, reason });
const measured = (value: number | undefined, reason = "missing duration"): Metric =>
  value === undefined || !Number.isFinite(value) || value < 0 ? unknown(reason) : { status: "ok", ms: round(value) };
const censored = (reason: string, observed?: number): Metric => ({
  status: "censored", ms: null, reason, ...(observed === undefined ? {} : { observedMs: round(observed) }),
});
const key = (job: string, batch: string) => JSON.stringify([job, batch]);
const first = (events: TimingEvent[], stage: string) => events.find((event) => event.stage === stage);
function declaredConditions(trace: Conditions = {}, override: Conditions = {}): Required<Conditions> {
  const input = { ...trace, ...override };
  const result = { scenarioId: input.scenarioId ?? "unspecified", source: input.source ?? "unknown",
    connection: input.connection ?? "unknown", cache: input.cache ?? "unknown" };
  if (typeof result.scenarioId !== "string" || !result.scenarioId.trim()
    || !["mock", "live", "unknown"].includes(result.source)
    || !["cold", "warm", "unknown"].includes(result.connection)
    || !["miss", "hit", "partial", "disabled", "unknown"].includes(result.cache)) {
    throw new Error("Invalid performance conditions: use documented source, connection and cache labels plus a nonempty scenarioId.");
  }
  return result;
}

/** Never compare monotonic timestamps from distinct realms or ambiguous restarts. */
function elapsed(events: TimingEvent[], from: string, to: string): Metric {
  const starts = events.filter((event) => event.stage === from);
  const ends = events.filter((event) => event.stage === to);
  if (starts.length !== 1 || ends.length !== 1) return unknown("missing or ambiguous stage pair");
  const a = starts[0]!, b = ends[0]!;
  if (a.layer !== b.layer || !a.clockId || a.clockId !== b.clockId) return unknown("unverified clock identity");
  return b.atMs >= a.atMs ? measured(b.atMs - a.atMs) : unknown("clock order invalid");
}

function completion(start: TimingEvent | undefined, end: TimingEvent | undefined, interrupted = false): Metric {
  if (!start) return unknown("start event missing");
  if (!end) return unknown("terminal event missing");
  const duration = number(end, "durationMs");
  if (interrupted || end.values?.cancelled === true) return censored("cancelled or interrupted", duration);
  if ((number(end, "failed") ?? 0) > 0 || (number(end, "invalidated") ?? 0) > 0
    || end.values?.success === false) return censored("failed or invalidated", duration);
  if (number(end, "blocks") === 0 || number(start, "blocks") === 0) return unknown("empty cohort");
  if (number(end, "blocks") === undefined || number(end, "failed") !== 0
    || number(end, "invalidated") !== 0 || number(end, "pending") !== 0) return unknown("terminal counts incomplete");
  if ((number(end, "completed") ?? -1) + (number(end, "skipped") ?? -1) !== number(end, "blocks")) {
    return unknown("terminal counts inconsistent");
  }
  return measured(duration);
}

/** One export and one page job. Multiple exports are summarized independently. */
export function summarizePerformance(trace: PerformanceTrace, options: { jobId?: string; conditions?: Conditions } = {}) {
  const allPage = trace.page ?? [], allHost = trace.host ?? [], allBackground = trace.background ?? [];
  const jobs = [...new Set(allPage.filter((event) => event.stage === "session.start").flatMap((event) => event.jobId ? [event.jobId] : []))];
  const jobId = options.jobId ?? (jobs.length === 1 ? jobs[0] : undefined);
  if (!jobId) throw new Error("Specify --job when the export contains zero or multiple page sessions.");
  const page = allPage.filter((event) => event.jobId === jobId);
  const background = allBackground.filter((event) => event.jobId === jobId);
  const starts = page.filter((event) => event.stage === "session.start");
  if (starts.length > 1) throw new Error("Ambiguous page session: the selected job has multiple starts; keep exports separate.");
  const start = starts[0];
  const samePageClock = (event: TimingEvent) => !start?.clockId || !event.clockId || start.clockId === event.clockId;
  if (page.some((event) => !samePageClock(event))) throw new Error("Selected job spans multiple page clocks; keep exports separate.");

  const reading = page.filter((event) => event.stage === "reading.started").map((begin) => {
    const epoch = number(begin, "epoch");
    const events = epoch === undefined ? [] : page.filter((event) => number(event, "epoch") === epoch && event.stage.startsWith("reading."));
    const duplicate = events.filter((event) => event.stage === "reading.started").length > 1;
    const end = events.find((event) => event.stage === "reading.completed" || event.stage === "reading.interrupted");
    return {
      epoch: epoch ?? null, fromScroll: begin.values?.fromScroll === true,
      blocks: number(begin, "blocks") ?? null,
      alreadyCompleted: number(begin, "alreadyCompleted") ?? null,
      availableAtStart: number(begin, "availableAtStart") ?? null,
      availableAtCapture: number(begin, "availableAtCapture") ?? null,
      captureDelayMs: number(begin, "captureDelayMs") ?? null,
      firstVisible: duplicate ? unknown("ambiguous reading epoch") : measured(number(first(events, "reading.firstVisible"), "durationMs"), "no newly visible translation observed"),
      completion: duplicate ? unknown("ambiguous reading epoch") : completion(begin, end, end?.stage === "reading.interrupted"),
    };
  });
  const extraction = first(page, "extraction.end");
  const sessionEnd = first(page, "session.end");
  const click = first(page, "ui.firstVisible");
  const metrics = {
    firstVisible: start ? measured(number(first(page, "dom.firstVisible"), "sinceSessionMs"), "no newly visible translation observed") : unknown("session start missing"),
    clickToFirstVisible: click?.values?.clockValid === false ? unknown("wall clock invalid")
      : start ? measured(number(click, "clickToVisibleMs")) : unknown("session start missing"),
    firstScreen: reading.find((cohort) => !cohort.fromScroll)?.completion ?? unknown("initial reading cohort missing"),
    wholePage: completion(extraction && start ? { ...start, values: { blocks: number(extraction, "blocks") ?? -1 } } : undefined, sessionEnd),
  };

  const providerGroups = new Map<string, { jobId: string; batchId: string; pageBatchIds: Set<string> }>();
  const pageBatchIds = [...new Set([...page, ...background].flatMap((event) => event.batchId ? [event.batchId] : []))];
  const pageBatches = pageBatchIds.map((batchId) => {
    const events = background.filter((event) => event.batchId === batchId);
    const links = events.filter((event) => event.stage === "reuse.link" && event.providerJobId && event.providerBatchId);
    const linked = new Set<string>();
    for (const link of links) {
      const id = key(link.providerJobId!, link.providerBatchId!);
      linked.add(id);
      const group = providerGroups.get(id) ?? { jobId: link.providerJobId!, batchId: link.providerBatchId!, pageBatchIds: new Set<string>() };
      group.pageBatchIds.add(batchId); providerGroups.set(id, group);
    }
    const end = first(events, "reuse.end");
    const expected = number(end, "providerGroups");
    const cacheOnly = end?.values?.success === true && expected === 0 && linked.size === 0;
    const sent = page.some((event) => event.stage === "batch.send" && event.batchId === batchId);
    const linkComplete = sent && expected !== undefined && Number.isInteger(expected) && expected === linked.size;
    return { batchId, cacheOnly, success: end?.values?.success === true,
      expectedProviderGroups: expected ?? null, observedProviderGroups: linked.size, linkComplete };
  });
  const providers = [...providerGroups.values()].map((group) => {
    const events = allHost.filter((event) => event.jobId === group.jobId && event.batchId === group.batchId);
    const end = first(events, "batch.end");
    const clocks = new Set(events.flatMap((event) => event.clockId ? [event.clockId] : []));
    const coverage = Boolean(first(events, "queue.enter") && end) && clocks.size <= 1;
    const consumers = new Set(allBackground.filter((event) => event.stage === "reuse.link"
      && event.providerJobId === group.jobId && event.providerBatchId === group.batchId && event.jobId && event.batchId)
      .map((event) => key(event.jobId!, event.batchId!)));
    return {
      providerJobId: group.jobId, providerBatchId: group.batchId, pageBatchIds: [...group.pageBatchIds],
      shared: consumers.size > 1, coverage, completed: end?.values?.completed === true,
      cancelled: end?.values?.cancelled === true, timedOut: end?.values?.timedOut === true,
      observedRequests: events.filter((event) => event.stage === "request.dispatch").length,
      queue: measured(number(first(events, "queue.leave"), "waitMs")),
      providerToPreview: elapsed(events, "provider.start", "provider.firstPreview"),
      dispatchToHeaders: elapsed(events, "request.dispatch", "request.headers"),
      headersToDelta: elapsed(events, "request.headers", "first.delta"),
    };
  });
  const logs = new Map<string, TimingEvent[]>();
  for (const event of [...allPage, ...allBackground, ...allHost]) {
    if (!event.logId) continue;
    const events = logs.get(event.logId) ?? []; events.push(event); logs.set(event.logId, events);
  }
  const truncatedLogs = [...logs].filter(([, events]) => Math.min(...events.map((event) => event.sequence ?? Infinity)) > 1).map(([id]) => id);
  const legacyClocks = [...page, ...background, ...allHost].some((event) => !event.clockId || !event.logId || event.sequence === undefined);
  const noTranslationRequired = number(sessionEnd, "blocks") !== undefined
    && number(sessionEnd, "blocks")! > 0 && number(sessionEnd, "skipped") === number(sessionEnd, "blocks");
  const complete = Boolean(start && sessionEnd) && (pageBatches.length > 0 || noTranslationRequired) && truncatedLogs.length === 0 && !legacyClocks
    && pageBatches.every((batch) => batch.linkComplete) && providers.every((provider) => provider.coverage);
  const observedRequests = providers.reduce((sum, provider) => sum + provider.observedRequests, 0);
  return {
    schemaVersion: 1, jobId,
    conditions: declaredConditions(trace.conditions, options.conditions),
    boundaries: {
      visible: "Nonempty visible DOM translation, not browser paint.",
      wholePage: "First settled pass only; whole-page completion requires a fixed static fixture.",
      clocks: "Event atMs values are local to clockId. No cross-process subtraction. Click uses wall clock.",
      requests: "Unique linked provider groups. Shared requests must not be summed across page reports.",
    },
    metrics, extractionMs: number(extraction, "durationMs") ?? null, reading, pageBatches, providers,
    harnessProviderCalls: Number.isInteger(trace.providerCalls) && trace.providerCalls! >= 0 ? trace.providerCalls! : null,
    coverage: { complete, truncatedLogs, legacyClocks, observedRequests, totalRequests: complete ? observedRequests : null,
      cacheOnlyBatches: pageBatches.filter((batch) => batch.cacheOnly).length },
  };
}

export type PerformanceReport = ReturnType<typeof summarizePerformance>;

/** Nearest-rank percentiles; failed, censored and missing samples never become zero. */
function statistics(metrics: Metric[]) {
  const values = metrics.flatMap((metric) => metric.status === "ok" && metric.ms !== null ? [metric.ms] : []).sort((a, b) => a - b);
  const percentile = (p: number) => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)]! : null;
  return { n: values.length, total: metrics.length, unknown: metrics.filter((metric) => metric.status === "unknown").length,
    censored: metrics.filter((metric) => metric.status === "censored").length, p50: percentile(0.5), p95: percentile(0.95) };
}

export function aggregatePerformance(reports: PerformanceReport[]) {
  const groups = new Map<string, PerformanceReport[]>();
  for (const report of reports) {
    const { scenarioId, source, connection, cache } = report.conditions;
    const id = JSON.stringify([scenarioId, source, connection, cache]);
    const group = groups.get(id) ?? []; group.push(report); groups.set(id, group);
  }
  return [...groups.values()].map((group) => ({
    conditions: group[0]!.conditions, samples: group.length,
    metrics: Object.fromEntries((Object.keys(group[0]!.metrics) as (keyof PerformanceReport["metrics"])[])
      .map((metric) => [metric, statistics(group.map((report) => report.metrics[metric]))])),
    // Epoch identity is preserved: do not mix first scroll with later scroll stops.
    scrolling: [...new Set(group.flatMap((report) => report.reading.filter((cohort) => cohort.fromScroll).map((cohort) => cohort.epoch)))].map((epoch) => {
      const cohorts = group.map((report) => report.reading.find((cohort) => cohort.fromScroll && cohort.epoch === epoch));
      return { epoch, firstVisible: statistics(cohorts.map((cohort) => cohort?.firstVisible ?? unknown("scroll cohort missing"))),
        completion: statistics(cohorts.map((cohort) => cohort?.completion ?? unknown("scroll cohort missing"))) };
    }),
  }));
}
