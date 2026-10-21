import type { TimingLog } from "../../shared/diagnostics.js";
import type { SourceRange } from "./extract.js";

interface ReadingBlock {
  range: SourceRange;
  status: "pending" | "running" | "completed" | "skipped" | "failed" | "superseded";
  output?: HTMLElement;
}

function outputVisible(output: HTMLElement): boolean {
  const rect = output.getBoundingClientRect();
  const height = output.ownerDocument.defaultView?.innerHeight || 800;
  const width = output.ownerDocument.defaultView?.innerWidth || 1_024;
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < height
    && rect.right > 0 && rect.left < width;
}

/** Undefined means this environment has no Range geometry (not a hidden run). */
function sourceRangeRects(range: SourceRange): DOMRect[] | undefined {
  const document = range.element.ownerDocument;
  const first = range.nodes[0];
  const last = range.nodes[range.nodes.length - 1];
  if (!first?.isConnected || !last?.isConnected) return [];
  const selection = document.createRange();
  selection.setStartBefore(first);
  selection.setEndAfter(last);
  return typeof selection.getClientRects === "function" ? Array.from(selection.getClientRects()) : undefined;
}

/** Vertical extent of this original run, excluding translations and nested lists. */
export function sourceRangeBounds(range: SourceRange, output?: HTMLElement): Pick<DOMRect, "top" | "bottom"> | undefined {
  if (output) return output.getBoundingClientRect();
  const rects = sourceRangeRects(range);
  if (!rects) return range.element.getBoundingClientRect();
  const boxes = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (!boxes.length) return undefined;
  return { top: Math.min(...boxes.map((rect) => rect.top)), bottom: Math.max(...boxes.map((rect) => rect.bottom)) };
}

/** Measure the source run, not a parent list item's entire nested subtree. */
export function sourceRangeVisible(range: SourceRange, output?: HTMLElement): boolean {
  const document = range.element.ownerDocument;
  const height = document.defaultView?.innerHeight || 800;
  const width = document.defaultView?.innerWidth || 1_024;
  const visible = (rect: DOMRect) => rect.width > 0 && rect.height > 0
    && rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width;
  // Translation-only mode may hide the original run, but the displayed output
  // still occupies the reader's screen. Bilingual source sampling ignores it.
  if (output) return outputVisible(output);
  const rects = sourceRangeRects(range);
  if (rects) return rects.some(visible);
  // JSDOM has no layout/Range geometry. This fallback does not affect Chromium.
  const rect = range.element.getBoundingClientRect();
  return rect.bottom >= 0 && rect.top <= height;
}

/** A fixed set of source versions observed during one reading stop. */
export class ReadingCohort<T extends ReadingBlock> {
  private epoch = 0;
  private deferred?: {
    jobId: string;
    started: number;
    before: Map<T, { text: string; status: T["status"]; available: boolean }>;
    first: Map<T, number>;
    finished: Map<T, number>;
  };
  private current?: {
    jobId: string;
    epoch: number;
    started: number;
    entries: Map<T, string>;
    alreadyCompleted: number;
    availableAtStart: number;
    firstVisible: boolean;
    completed: boolean;
    finished: Map<T, number>;
  };

  constructor(private readonly timings: TimingLog) {}

  /** Capture timing now; choose membership after the merged scroll reaches its final viewport. */
  deferScroll(jobId: string, blocks: T[]): void {
    if (!this.deferred) {
      this.end();
      this.deferred = { jobId, started: performance.now(), first: new Map(), finished: new Map(),
        before: new Map(blocks.map((block) => [block, { text: block.output?.textContent ?? "", status: block.status,
          available: Boolean(block.output?.textContent?.trim()) && outputVisible(block.output!) }])) };
    }
    this.observeDeferred();
  }

  start(jobId: string, blocks: T[], fromScroll: boolean, visible: (block: T) => boolean): void {
    if (fromScroll && this.deferred?.jobId !== jobId) return;
    const deferred = fromScroll ? this.deferred : undefined;
    this.deferred = undefined;
    this.end();
    const selected = blocks.filter(visible);
    const started = deferred?.started ?? performance.now();
    this.current = {
      jobId, epoch: ++this.epoch, started,
      entries: new Map(selected.map((block) => [block, deferred?.before.get(block)?.text ?? block.output?.textContent ?? ""])),
      alreadyCompleted: selected.filter((block) => (deferred?.before.get(block)?.status ?? block.status) === "completed").length,
      availableAtStart: selected.filter((block) => deferred ? deferred.before.get(block)?.available
        : Boolean(block.output?.textContent?.trim()) && outputVisible(block.output!)).length,
      firstVisible: false, completed: false,
      finished: deferred?.finished ?? new Map(),
    };
    this.mark("reading.started", { fromScroll, captureDelayMs: performance.now() - started,
      availableAtCapture: selected.filter((block) => Boolean(block.output?.textContent?.trim()) && outputVisible(block.output!)).length });
    const first = deferred ? selected.flatMap((block) => deferred.first.has(block) ? [deferred.first.get(block)!] : []) : [];
    if (first.length) {
      this.current.firstVisible = true;
      this.mark("reading.firstVisible", { observedBeforeCapture: true }, Math.min(...first));
    }
    this.check();
  }

  rendered(block: T): void {
    this.observeDeferred(block);
    const current = this.current;
    if (!current || current.completed || current.firstVisible || !current.entries.has(block)) return;
    const text = block.output?.textContent?.trim();
    if (!text || text === current.entries.get(block)?.trim() || !block.output) return;
    if (!outputVisible(block.output)) return;
    current.firstVisible = true;
    this.mark("reading.firstVisible");
  }

  check(): void {
    this.observeDeferred();
    if (!this.current || this.current.completed) return;
    const blocks = [...this.current.entries.keys()];
    for (const block of blocks) {
      if (block.status !== "pending" && block.status !== "running" && !this.current.finished.has(block)) {
        this.current.finished.set(block, performance.now());
      }
    }
    if (blocks.some((block) => block.status === "pending" || block.status === "running")) return;
    this.current.completed = true;
    this.mark("reading.completed", {}, Math.max(this.current.started, ...blocks.map((block) => this.current!.finished.get(block)!)));
  }

  /** A new reading stop or explicit cancellation censors unfinished durations. */
  end(): void {
    if (this.current && !this.current.completed) this.mark("reading.interrupted");
    if (this.deferred) this.timings.mark("reading.captureCancelled", { jobId: this.deferred.jobId }, {
      durationMs: performance.now() - this.deferred.started,
    });
    this.current = undefined;
    this.deferred = undefined;
  }

  private observeDeferred(rendered?: T): void {
    const pending = this.deferred;
    if (!pending) return;
    const now = performance.now();
    for (const block of rendered ? [rendered] : pending.before.keys()) {
      const before = pending.before.get(block);
      if (!before) continue;
      if (!pending.first.has(block) && block.output?.textContent?.trim()
        && block.output.textContent !== before.text && outputVisible(block.output)) pending.first.set(block, now);
      if (!pending.finished.has(block) && block.status !== "pending" && block.status !== "running") {
        pending.finished.set(block, before.status === "pending" || before.status === "running" ? now : pending.started);
      }
    }
  }

  private mark(stage: string, extra: Record<string, number | boolean> = {}, at = performance.now()): void {
    const current = this.current!;
    const blocks = [...current.entries.keys()];
    this.timings.mark(stage, { jobId: current.jobId }, {
      epoch: current.epoch, durationMs: at - current.started,
      blocks: blocks.length, alreadyCompleted: current.alreadyCompleted,
      availableAtStart: current.availableAtStart,
      completed: blocks.filter((block) => block.status === "completed").length,
      skipped: blocks.filter((block) => block.status === "skipped").length,
      pending: blocks.filter((block) => block.status === "pending" || block.status === "running").length,
      failed: blocks.filter((block) => block.status === "failed").length,
      invalidated: blocks.filter((block) => block.status === "superseded").length,
      ...extra,
    });
  }
}
