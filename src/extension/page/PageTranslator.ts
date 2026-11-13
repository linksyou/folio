import {
  type PageAction,
  type PageState,
  type Result,
  type TextBlock,
  type Translation,
  type TranslationPriority,
} from "../../shared/protocol.js";

import { canHideRange, collectHostRanges, collectRanges, rangeStillMatches, sameRange, type SourceRange } from "./extract.js";
import { TimingLog } from "../../shared/diagnostics.js";
import type { DisplayMode, TargetLanguage } from "../../shared/languages.js";
import { isAlreadyTargetLanguage } from "./language.js";
import { PROTECTED_TOKEN, preservesProtectedText, restoreProtectedText } from "../../shared/protected-text.js";
import { ReadingCohort, sourceRangeBounds, sourceRangeVisible } from "./ReadingCohort.js";

// Small batches reduce time to the first visible paragraph. The host still enforces
// its independent 5-block / 4,000-character safety limits.
const BATCH_BLOCKS = 2;
const VISIBLE_BATCH_BLOCKS = 3;
const BATCH_CHARACTERS = 1_800;
const CHUNK_CHARACTERS = 1_500;
const SHORT_BLOCK_CHARACTERS = 600;
const DYNAMIC_DELAY_MS = 50;
const GENERATED_ATTRIBUTE = "data-folio";
const HIDDEN_SOURCE_ATTRIBUTE = "data-folio-source-hidden";
const DISPLAY_STYLE_ATTRIBUTE = "data-folio-display-style";
const PAUSE_ERROR_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "NEEDS_LOGIN",
  "PLAN_DISABLED",
  "LIMIT_REACHED",
  "UNAUTHORIZED",
  "ACCESS_DENIED",
  "INVALID_CONFIG",
  "CONFIG_REQUIRED",
  "HOST_UNAVAILABLE",
  "NATIVE_DISCONNECTED",
]);

type BlockStatus = "pending" | "running" | "completed" | "skipped" | "failed" | "superseded";

interface Chunk {
  id: string;
  text: string;
  block: PageBlock;
  index: number;
}

interface PageBlock {
  id: string;
  element: HTMLElement;
  range: SourceRange;
  key: Node;
  source: string;
  languageHint?: string;
  sourceRevision: number;
  lastDispatched: number;
  chunks: Chunk[];
  translatedChunks: Map<number, string>;
  partialChunks: Map<number, string>;
  status: BlockStatus;
  translation?: string;
  output?: HTMLElement;
}

interface CacheEntry {
  range: SourceRange;
  source: string;
  url: string;
  settingsRevision: string;
  translation: string;
}

interface Batch {
  chunks: Chunk[];
}

interface ActiveBatch {
  batch: Batch;
  controller: AbortController;
}

export interface TranslationOptions {
  onProgress?: (translations: Translation[]) => void;
  signal?: AbortSignal;
  priority?: TranslationPriority;
}

export interface TranslationTransport {
  translate(
    jobId: string,
    settingsRevision: string,
    blocks: TextBlock[],
    options?: TranslationOptions,
  ): Promise<Result<Translation[]>>;
  cancel(jobId: string): Promise<void>;
}

export interface PageTranslatorOptions {
  getUrl?: () => string;
  onStateChange?: (state: PageState) => void;
}

function splitText(text: string, limit = CHUNK_CHARACTERS): string[] {
  if (text.length <= limit) return [text];

  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const candidates = [
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("; "),
      window.lastIndexOf(", "),
      window.lastIndexOf(" "),
    ];
    const best = Math.max(...candidates);
    let cut = best >= Math.floor(limit * 0.5) ? best + 1 : limit;
    for (const match of rest.matchAll(PROTECTED_TOKEN)) {
      if (match.index > 0 && match.index < cut && match.index + match[0].length > cut) { cut = match.index; break; }
    }
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

function stateMessage(status: PageState["status"], failed: number): string {
  if (status === "running") return "优先翻译当前屏幕，并继续翻译其余正文…";
  if (status === "watching") return "等待页面中的可翻译正文…";
  if (status === "paused") return "连接或额度需要处理，已暂停后续翻译。";
  if (status === "completed" && failed > 0) return "翻译完成，部分段落可重试。";
  if (status === "completed") return "当前正文已翻译，新增正文会自动继续。";
  if (status === "stopped") return "翻译已停止，可重试未完成段落。";
  if (status === "error") return "翻译未完成，请检查页面或连接。";
  return "尚未翻译当前页面。";
}

export class PageTranslator {
  private readonly timings = new TimingLog("page");
  private readonly reading = new ReadingCohort<PageBlock>(this.timings);
  private firstVisible = false;
  private runStarted = 0;
  private initialPassEnded = true;
  private state: PageState = {
    status: "idle",
    total: 0,
    completed: 0,
    failed: 0,
    message: stateMessage("idle", 0),
  };

  private blocks: PageBlock[] = [];
  private readonly byNode = new Map<Node, PageBlock>();
  private readonly identities = new WeakMap<Node, { id: string; source: string; revision: number; invalidated?: boolean }>();
  private nextBlockId = 0;
  private dispatchSequence = 0;
  private displayMode: DisplayMode = "bilingual";
  private targetLanguage: TargetLanguage = "zh-CN";
  private forceTranslation = false;
  private readonly hiddenSources = new Map<PageBlock, { texts: Map<Text, string>; elements: HTMLElement[] }>();
  private readonly hiddenTextOwners = new WeakMap<Text, PageBlock>();
  private readonly acceptedTextEdits = new WeakSet<MutationRecord>();
  private cache = new WeakMap<Node, CacheEntry>();
  private observer?: MutationObserver;
  private presentationDepth = 0;
  private presentationWrites: { node: Text; oldValue: string }[] = [];
  private generation = 0;
  private jobId?: string;
  private settingsRevision?: string;
  private runUrl = "";
  private activeRun: Promise<void> = Promise.resolve();
  private viewportTask: Promise<void> = Promise.resolve();
  private viewportScheduled = false;
  private discoveryTask: Promise<void> = Promise.resolve();
  private discoveryScheduled = false;
  private dirtyHosts = new Map<HTMLElement, number>();
  private fullDiscovery = false;
  private viewportEpoch = 0;
  private settledViewportEpoch = -1;
  private viewportStarted = 0;
  private scrollScheduled = false;
  private scrollDirection = 1;
  private lastViewportTop?: number;
  private runningGeneration?: number;
  private wakeRun?: () => void;
  private enabled = false;
  private disposed = false;
  private readonly onScroll = () => this.scheduleViewport(true);
  private readonly onViewportChange = () => this.scheduleViewport();
  // CSS can reveal initially transparent prose without a DOM mutation.
  private readonly onPresentationEnd = (event: Event) => {
    const target = event.target as Element | null;
    if (this.disposed || target?.nodeType !== 1
      || target.closest(`[${GENERATED_ATTRIBUTE}], [data-folio-ui]`)) return;
    if (event.type === "transitionend"
      && !["opacity", "visibility", "display"].includes((event as TransitionEvent).propertyName)) return;
    this.scheduleDiscovery();
  };
  private readonly activeBatches = new Set<ActiveBatch>();

  constructor(
    private readonly document: Document,
    private readonly transport: TranslationTransport,
    private readonly options: PageTranslatorOptions = {},
  ) {
    const MutationObserver = document.defaultView?.MutationObserver;
    this.ensureDisplayStyle();
    if (MutationObserver && document.documentElement) {
      // The document root survives a replaced body; no stale body observer remains.
      this.observer = new MutationObserver((records) => this.validateExistingBlocks(records));
      this.observer.observe(document.documentElement, {
        childList: true,
        characterData: true,
        characterDataOldValue: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden", "aria-hidden", "style", "class", "role", "contenteditable", "lang", "translate"],
      });
    }
    // Capturing also observes scrolls inside an article's own scroll container.
    document.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    document.addEventListener("visibilitychange", this.onViewportChange);
    document.addEventListener("animationend", this.onPresentationEnd, true);
    document.addEventListener("transitionend", this.onPresentationEnd, true);
    document.defaultView?.addEventListener("resize", this.onViewportChange, { passive: true });
  }

  getState(): PageState {
    if (!this.disposed) this.invalidateIfPageChanged();
    return { ...this.state };
  }

  getDiagnostics() { return this.timings.read(); }

  /** Retire an invalid extension context without removing completed translations. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.document.removeEventListener("scroll", this.onScroll, true);
    this.document.removeEventListener("visibilitychange", this.onViewportChange);
    this.document.removeEventListener("animationend", this.onPresentationEnd, true);
    this.document.removeEventListener("transitionend", this.onPresentationEnd, true);
    this.document.defaultView?.removeEventListener("resize", this.onViewportChange);
    void this.stop();
  }

  setDisplayMode(mode: DisplayMode): void {
    if (this.disposed) return;
    this.displayMode = mode;
    for (const block of this.blocks) this.applyDisplayMode(block);
    this.scheduleViewport();
  }

  setTargetLanguage(language: TargetLanguage): void {
    if (!this.disposed) this.targetLanguage = language;
  }

  async whenIdle(): Promise<void> {
    // A scroll may start another drain while the current promises settle.
    for (;;) {
      // Deliver source MutationObserver records before taking the task snapshot.
      await Promise.resolve();
      const discovery = this.discoveryTask;
      await discovery;
      const viewport = this.viewportTask;
      await viewport;
      const run = this.activeRun;
      await run;
      await Promise.resolve();
      if (discovery === this.discoveryTask && viewport === this.viewportTask && run === this.activeRun) return;
    }
  }

  handle(action: PageAction, jobId?: string, settingsRevision?: string): PageState {
    if (this.disposed) return this.getState();
    if (action === "status") return this.getState();
    if (action === "restore") {
      void this.restore();
      return this.getState();
    }
    if (action === "stop") {
      void this.stop();
      return this.getState();
    }
    if (!jobId || !settingsRevision) {
      this.setState("error", "后台没有提供有效的翻译任务，请重试。");
      return this.getState();
    }
    if (action === "retry") return this.beginRetry(jobId, settingsRevision);
    return this.beginStart(jobId, settingsRevision, action === "retranslate");
  }

  private currentUrl(): string {
    return this.options.getUrl?.() ?? this.document.location?.href ?? "";
  }

  private beginStart(jobId: string, settingsRevision: string, force = false): PageState {
    this.endInitialPass("stopped");
    this.reading.end();
    this.scrollScheduled = false;
    void this.cancelCurrent();
    this.generation += 1;
    this.enabled = true;
    this.forceTranslation = force;
    if (force) this.cache = new WeakMap();
    this.removeOutputs();
    this.jobId = jobId;
    this.settingsRevision = settingsRevision;
    this.runUrl = this.currentUrl();
    this.runStarted = performance.now();
    this.initialPassEnded = false;
    this.firstVisible = false;
    this.timings.mark("session.start", { jobId });
    this.blocks = this.extractBlocks(settingsRevision);
    this.timings.mark("extraction.end", { jobId }, { durationMs: performance.now() - this.runStarted, blocks: this.blocks.length });
    this.beginReading(false);
    this.beginViewport();
    this.lastViewportTop = this.blocks[0] ? this.geometryBounds(this.blocks[0])?.top : undefined;

    if (this.blocks.length === 0) {
      // An enabled empty SPA can acquire its article after the initial click.
      this.refreshState("watching", "等待页面正文出现…");
      return this.getState();
    }

    if (this.blocks.every((block) => block.status === "completed" || block.status === "skipped")) {
      this.refreshState("completed");
    } else {
      this.refreshState("watching");
      this.pump();
    }
    return this.getState();
  }

  private beginRetry(jobId: string, settingsRevision: string): PageState {
    // Re-extraction includes changed source text; the per-element cache preserves
    // successful paragraphs and only missing/invalid results are requested again.
    return this.beginStart(jobId, settingsRevision);
  }

  private extractBlocks(settingsRevision: string): PageBlock[] {
    this.byNode.clear();
    return collectRanges(this.document).map((range) => this.createBlock(range, settingsRevision));
  }

  private createBlock(range: SourceRange, settingsRevision: string): PageBlock {
    const { element, source } = range;
    const key = range.nodes[0];
    let identity = this.identities.get(key);
    if (!identity) {
      identity = { id: `block-${++this.nextBlockId}`, source, revision: 1 };
      this.identities.set(key, identity);
    } else if (identity.source !== source || identity.invalidated) {
      identity = { id: identity.id, source, revision: identity.revision + 1 };
      this.identities.set(key, identity);
    }
    const cached = this.cache.get(key);
    const block: PageBlock = {
      id: identity.id,
      element,
      range,
      key,
      source,
      languageHint: element.closest("[lang]")?.getAttribute("lang") ?? undefined,
      sourceRevision: identity.revision,
      lastDispatched: 0,
      chunks: [],
      translatedChunks: new Map(),
      partialChunks: new Map(),
      status: "pending",
    };
    block.chunks = splitText(range.translationSource ?? source).map((text, index) => ({
      id: `${block.id}${block.sourceRevision > 1 ? `.v${block.sourceRevision}` : ""}.${index + 1}`,
      text,
      block,
      index,
    }));
    this.byNode.set(key, block);
    if (!this.forceTranslation && isAlreadyTargetLanguage(source, this.targetLanguage, block.languageHint)) {
      block.status = "skipped";
      block.chunks = [];
      return block;
    }
    if (
      cached &&
      sameRange(cached.range, range) &&
      cached.source === source &&
      cached.url === this.runUrl &&
      cached.settingsRevision === settingsRevision
    ) {
      block.translation = cached.translation;
      block.status = "completed";
      this.insertOutput(block, cached.translation);
    }
    return block;
  }

  private scheduleViewport(fromScroll = false): void {
    if (!this.enabled) return;
    if (fromScroll) {
      this.timings.mark("viewport.changed", { jobId: this.jobId });
      if (this.jobId) this.reading.deferScroll(this.jobId, this.blocks);
      this.scrollScheduled = true;
      const top = this.blocks[0] ? this.geometryBounds(this.blocks[0])?.top : undefined;
      if (top !== undefined && this.lastViewportTop !== undefined && top !== this.lastViewportTop) {
        this.scrollDirection = top < this.lastViewportTop ? 1 : -1;
      }
      this.lastViewportTop = top;
    }
    if (this.viewportScheduled) return;
    this.beginViewport();
    this.viewportScheduled = true;
    this.viewportTask = new Promise((resolve) => {
      setTimeout(() => {
        this.viewportScheduled = false;
        if (this.scrollScheduled && this.enabled) {
          this.beginReading(true);
        }
        if (this.enabled) this.abortDistantBatches();
        this.scrollScheduled = false;
        if (this.runningGeneration === this.generation) this.refreshState("running");
        this.pump();
        this.checkViewportSettled();
        resolve();
      }, 40);
    });
  }

  private pump(): void {
    this.invalidateIfPageChanged();
    if (!this.enabled || !this.jobId || !this.settingsRevision) return;
    if (this.runningGeneration === this.generation) {
      this.wakeRun?.();
      return;
    }
    const generation = this.generation;
    this.runningGeneration = generation;
    this.activeRun = this.run(this.jobId, this.settingsRevision, generation);
  }

  /** Prefer the viewport and nearby text; fill the rest only with spare capacity. */
  private viewportRank(block: PageBlock, includeDistant = false): number | undefined {
    const height = this.document.defaultView?.innerHeight || 800;
    const rect = this.geometryBounds(block);
    if (!rect) return undefined;
    const before = this.scrollDirection < 0 ? height : height * 0.5;
    const after = this.scrollDirection > 0 ? height : height * 0.5;
    if (rect.bottom < -before || rect.top > height + after) return includeDistant ? 2 : undefined;
    return rect.bottom >= 0 && rect.top <= height ? 0 : 1;
  }

  private abortDistantBatches(): void {
    if (this.document.visibilityState === "hidden") return;
    const reserved = new Set([...this.activeBatches]
      .filter((active) => !active.controller.signal.aborted)
      .flatMap((active) => active.batch.chunks.map((chunk) => chunk.id)));
    // Translation insertion can itself move the scroll anchor. Only preempt
    // useful background work when the reader has new, unassigned visible text.
    const needsVisible = this.blocks.some((block) =>
      (block.status === "pending" || block.status === "running")
      && this.viewportRank(block) === 0
      && block.chunks.some((chunk) => !block.translatedChunks.has(chunk.index) && !reserved.has(chunk.id)));
    if (!needsVisible) return;
    const height = this.document.defaultView?.innerHeight || 800;
    for (const active of this.activeBatches) {
      if (active.controller.signal.aborted) continue;
      const distant = active.batch.chunks.every(({ block }) => {
        const rect = this.geometryBounds(block);
        return !rect || rect.bottom < -height * 1.5 || rect.top > height * 2.5;
      });
      if (!distant) continue;
      this.cancelBatch(active);
      this.timings.mark("batch.cancelDistant", { jobId: this.jobId }, { blocks: active.batch.chunks.length });
    }
  }

  private nextBatch(reserved: Set<string>): Batch | undefined {
    // A hidden tab keeps making progress, but uses one request at a time. Any
    // foreground requests already in flight are allowed to finish naturally.
    if (this.document.visibilityState === "hidden" && reserved.size) return undefined;
    const candidates = this.blocks
      .filter((block) => block.status === "pending" || block.status === "running")
      .map((block) => ({ block, rank: this.viewportRank(block, true) }))
      .filter((item): item is { block: PageBlock; rank: number } => item.rank !== undefined)
      .sort((left, right) => left.rank - right.rank
        || (left.block.range.readingPriority ?? 1) - (right.block.range.readingPriority ?? 1)
        || Number(left.block.chunks.some((chunk) => reserved.has(chunk.id)))
          - Number(right.block.chunks.some((chunk) => reserved.has(chunk.id)))
        || left.block.lastDispatched - right.block.lastDispatched);
    const chunks: Chunk[] = [];
    let characters = 0;
    let selectedRank: number | undefined;
    for (const { block, rank } of candidates) {
      const chunk = block.chunks.find((item) => !block.translatedChunks.has(item.index) && !reserved.has(item.id));
      if (!chunk) continue;
      if (selectedRank !== undefined && rank !== selectedRank) break;
      // Finish viewport/prefetch work before filling distant text. Keep a slot
      // available so scrolling or newly inserted visible text can start at once.
      if (rank === 2 && reserved.size) break;
      // A long block remains a single-text stream. Prefer another visible block
      // before assigning both workers to chunks of this same paragraph.
      const short = block.chunks.length === 1 && chunk.text.length <= SHORT_BLOCK_CHARACTERS;
      if (!short) return chunks.length ? { chunks } : { chunks: [chunk] };
      if (chunks.length && characters + chunk.text.length > BATCH_CHARACTERS) break;
      selectedRank = rank;
      chunks.push(chunk);
      characters += chunk.text.length;
      if (chunks.length === (rank === 0 ? VISIBLE_BATCH_BLOCKS : BATCH_BLOCKS)) break;
    }
    return chunks.length ? { chunks } : undefined;
  }

  private async requestBatch(
    batch: Batch,
    jobId: string,
    settingsRevision: string,
    generation: number,
  ): Promise<{ result: Result<Translation[]>; aborted: boolean }> {
    const active: ActiveBatch = { batch, controller: new AbortController() };
    const { signal } = active.controller;
    const expected = new Map(batch.chunks.map((chunk) => [chunk.id, chunk]));
    this.activeBatches.add(active);
    let onAbort!: () => void;
    const cancelled = new Promise<Result<Translation[]>>((resolve) => {
      onAbort = () => resolve({
        ok: false,
        error: { code: "CANCELLED", message: "当前段落已取消。" },
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const request = this.transport.translate(
        jobId, settingsRevision, batch.chunks.map(({ id, text }) => ({ id, text })),
        {
          signal,
          priority: this.document.visibilityState === "hidden" ? "background"
            : batch.chunks.some(chunk => this.viewportRank(chunk.block) === 0) ? "visible"
              : batch.chunks.some(chunk => this.viewportRank(chunk.block) === 1) ? "prefetch" : "background",
          onProgress: (translations) => {
            if (signal.aborted || !this.activeBatches.has(active) || !this.isCurrent(generation, jobId)) return;
            this.acceptProgress(expected, translations);
          },
        },
      );
      // Transport cancellation should stop the provider request. Racing here
      // also keeps a disconnected or obsolete transport from freezing scrolling.
      const result = await Promise.race([request, cancelled]);
      return { result, aborted: signal.aborted };
    } catch {
      return {
        aborted: signal.aborted,
        result: {
          ok: false,
          error: { code: "HOST_UNAVAILABLE", message: "本地辅助程序连接中断，可重新连接后重试。" },
        },
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.activeBatches.delete(active);
    }
  }

  private async run(jobId: string, settingsRevision: string, generation: number): Promise<void> {
    const reserved = new Set<string>();
    const waiters = new Set<() => void>();
    const wake = () => {
      for (const resolve of waiters) resolve();
      waiters.clear();
    };
    this.wakeRun = wake;
    const worker = async (): Promise<void> => {
      while (this.enabled && this.isCurrent(generation, jobId)) {
        // Pick at dispatch time, so a scroll changes what is sent next.
        const batch = this.nextBatch(reserved);
        if (!batch) {
          if (!reserved.size) return;
          // Stay available while the other worker is busy. Scrolls, discovery
          // and visibility changes can immediately reuse this otherwise idle slot.
          await new Promise<void>((resolve) => waiters.add(resolve));
          continue;
        }
        for (const chunk of batch.chunks) {
          reserved.add(chunk.id);
          chunk.block.status = "running";
          chunk.block.lastDispatched = ++this.dispatchSequence;
        }
        this.refreshState("running");
        const { result, aborted } = await this.requestBatch(batch, jobId, settingsRevision, generation);
        for (const chunk of batch.chunks) reserved.delete(chunk.id);
        wake();
        if (!this.isCurrent(generation, jobId)) {
          this.invalidateIfPageChanged();
          return;
        }
        if (aborted) continue;
        if (!result.ok) {
          this.failBatch(batch);
          if (PAUSE_ERROR_CODES.has(result.error.code)) {
            this.enabled = false;
            this.abortActiveBatches();
            this.failRemaining(this.blocks);
            this.refreshState("paused", result.error.message);
            this.generation += 1;
            await this.transport.cancel(jobId).catch(() => undefined);
            return;
          }
        } else {
          this.acceptBatch(batch, result.result, settingsRevision);
        }
      }
    };

    await Promise.all([worker(), worker()]);
    if (this.wakeRun === wake) this.wakeRun = undefined;
    if (this.runningGeneration === generation) this.runningGeneration = undefined;
    if (!this.isCurrent(generation, jobId)) return;
    // New content can arrive between the last worker's exit and this cleanup.
    // Retry only dispatchable work, never spin on ranges with no layout.
    if (this.enabled && this.nextBatch(new Set())) {
      this.pump();
      return;
    }
    const hasPending = this.blocks.some((block) => block.status === "pending" || block.status === "running");
    this.refreshState(hasPending || !this.blocks.length ? "watching" : "completed");
  }

  private acceptProgress(expected: Map<string, Chunk>, translations: Translation[]): void {
    const affected = new Set<PageBlock>();
    for (const translation of translations) {
      const chunk = expected.get(translation.id);
      if (!chunk || !this.isRegistered(chunk.block) || chunk.block.status === "failed" || chunk.block.status === "completed") continue;
      if (typeof translation.text !== "string" || !translation.text) continue;
      if (!preservesProtectedText(chunk.text, translation.text, true)) continue;
      chunk.block.partialChunks.set(chunk.index, translation.text);
      affected.add(chunk.block);
    }
    for (const block of affected) {
      // Only inspect the paragraph receiving progress, never the entire page.
      if (!this.blockStillMatches(block)) {
        this.invalidateBlock(block);
        this.scheduleDiscovery();
        continue;
      }
      this.renderPreview(block);
    }
  }

  private renderPreview(block: PageBlock): void {
    const parts: string[] = [];
    for (const chunk of block.chunks) {
      const completed = block.translatedChunks.get(chunk.index);
      if (completed !== undefined) {
        parts.push(completed);
        continue;
      }
      const partial = block.partialChunks.get(chunk.index);
      if (partial) parts.push(partial);
      break; // Later chunks must never appear ahead of an unfinished prefix.
    }
    const text = restoreProtectedText(parts.join("").trim(), block.range.protectedText ?? [], true);
    if (text) this.insertOutput(block, text, true);
  }

  private acceptBatch(batch: Batch, translations: Translation[], settingsRevision: string): void {
    const expected = new Map(batch.chunks.map((chunk) => [chunk.id, chunk]));
    if (
      translations.length !== expected.size ||
      new Set(translations.map((item) => item.id)).size !== translations.length ||
      translations.some(
        (item) => !expected.has(item.id) || typeof item.text !== "string" || item.text.trim().length === 0
          || !preservesProtectedText(expected.get(item.id)!.text, item.text),
      )
    ) {
      this.failBatch(batch);
      return;
    }

    const affected = new Set<PageBlock>();
    for (const translation of translations) {
      const chunk = expected.get(translation.id);
      if (!chunk || !this.isRegistered(chunk.block) || chunk.block.status === "failed") continue;
      chunk.block.translatedChunks.set(chunk.index, translation.text.trim());
      chunk.block.partialChunks.delete(chunk.index);
      affected.add(chunk.block);
    }

    for (const block of affected) {
      if (!this.blockStillMatches(block)) {
        this.invalidateBlock(block);
        this.scheduleDiscovery();
        continue;
      }
      if (block.translatedChunks.size !== block.chunks.length) {
        this.renderPreview(block);
        continue;
      }
      const translated = block.chunks
        .map((chunk) => block.translatedChunks.get(chunk.index) ?? "")
        .join("")
        .trim();
      const translation = restoreProtectedText(translated, block.range.protectedText ?? []);
      if (!translation) {
        this.discardBlock(block);
        continue;
      }
      block.translation = translation;
      block.status = "completed";
      this.cache.set(block.key, {
        range: block.range,
        source: block.source,
        url: this.runUrl,
        settingsRevision,
        translation,
      });
      this.insertOutput(block, translation);
    }
    this.refreshState("running");
  }

  private failBatch(batch: Batch): void {
    for (const block of new Set(batch.chunks.map((chunk) => chunk.block))) {
      if (this.isRegistered(block) && block.status !== "completed") {
        this.discardBlock(block);
      }
    }
    this.refreshState(this.state.status === "paused" ? "paused" : "running");
  }

  private failRemaining(selected: PageBlock[]): void {
    for (const block of selected) {
      if (block.status !== "completed") {
        this.discardBlock(block);
      }
    }
  }

  private discardBlock(block: PageBlock): void {
    block.status = "failed";
    block.partialChunks.clear();
    block.translatedChunks.clear();
    block.output?.remove();
    block.output = undefined;
    this.cache.delete(block.key);
    this.showSource(block);
  }

  private isRegistered(block: PageBlock): boolean {
    return this.byNode.get(block.key) === block && block.status !== "superseded";
  }

  private blockStillMatches(block: PageBlock): boolean {
    return (
      this.currentUrl() === this.runUrl &&
      this.isRegistered(block) &&
      this.document.contains(block.element) &&
      block.languageHint === (block.element.closest("[lang]")?.getAttribute("lang") ?? undefined) &&
      this.withOriginalVisibility(() => rangeStillMatches(block.range), [block])
    );
  }

  private isCurrent(generation: number, jobId: string): boolean {
    return generation === this.generation && jobId === this.jobId && this.currentUrl() === this.runUrl;
  }

  private insertOutput(block: PageBlock, translation: string, pending = false): void {
    const output = block.output ?? this.document.createElement("span");
    if (!block.output) {
      output.setAttribute(GENERATED_ATTRIBUTE, "translation");
      output.className = "folio-translation";
    }
    if (output.textContent !== translation) output.textContent = translation;
    if (pending) output.setAttribute("aria-busy", "true");
    else output.removeAttribute("aria-busy");
    // The anchor belongs to this continuous source range, not to its outer card
    // or list item. Keeping output inside the source host preserves flex/grid items.
    const last = block.range.nodes[block.range.nodes.length - 1];
    if (last.parentNode !== block.element) return;
    if (last.nextSibling !== output) block.element.insertBefore(output, last.nextSibling);
    block.output = output;
    this.applyDisplayMode(block);
    this.reading.rendered(block);
    if (this.viewportRank(block) === 0 && !this.firstVisible) {
      this.firstVisible = true;
      this.timings.mark("dom.firstVisible", { jobId: this.jobId }, { sinceSessionMs: performance.now() - this.runStarted });
    }
  }

  private abortActiveBatches(): void {
    for (const active of this.activeBatches) active.controller.abort();
  }

  private cancelBatch(active: ActiveBatch): void {
    if (active.controller.signal.aborted) return;
    active.controller.abort();
    // A structured request may contain unchanged peers. Cancellation invalidates
    // every provisional result in that request, but those peers remain schedulable.
    for (const block of new Set(active.batch.chunks.map((chunk) => chunk.block))) {
      if (!this.isRegistered(block) || block.status === "failed" || block.status === "completed") continue;
      block.status = "pending";
      block.partialChunks.clear();
      block.output?.remove();
      block.output = undefined;
      this.showSource(block);
    }
  }

  private invalidateBlock(block: PageBlock): void {
    if (!this.isRegistered(block)) return;
    block.status = "superseded";
    const identity = this.identities.get(block.key);
    if (identity) this.identities.set(block.key, { ...identity, invalidated: true });
    this.byNode.delete(block.key);
    this.blocks = this.blocks.filter((candidate) => candidate !== block);
    block.partialChunks.clear();
    block.translatedChunks.clear();
    block.output?.remove();
    block.output = undefined;
    this.cache.delete(block.key);
    this.showSource(block);
    for (const active of this.activeBatches) {
      if (active.batch.chunks.some((chunk) => chunk.block === block)) this.cancelBatch(active);
    }
  }

  private ensureDisplayStyle(): void {
    if (this.document.querySelector(`[${DISPLAY_STYLE_ATTRIBUTE}]`)) return;
    const style = this.document.createElement("style");
    style.setAttribute(DISPLAY_STYLE_ATTRIBUTE, "");
    style.textContent = `[${HIDDEN_SOURCE_ATTRIBUTE}] { display: none !important; }`;
    (this.document.head ?? this.document.documentElement).append(style);
  }

  /** Keep presentation-only text writes out of discovery, but retain queued host edits. */
  private changePresentation<T>(change: () => T): T {
    if (this.presentationDepth) return change();
    const pending = this.observer?.takeRecords() ?? [];
    this.acceptHostTextEdits(pending);
    this.presentationDepth++;
    try { return change(); }
    finally {
      this.presentationDepth--;
      const writes = this.presentationWrites;
      this.presentationWrites = [];
      for (const record of this.observer?.takeRecords() ?? []) {
        const own = writes.findIndex((write) => record.type === "characterData"
          && record.target === write.node && record.oldValue === write.oldValue);
        if (own >= 0) writes.splice(own, 1);
        else pending.push(record);
      }
      if (pending.length) queueMicrotask(() => this.validateExistingBlocks(pending));
    }
  }

  private setPresentationText(node: Text, value: string): void {
    if (node.data === value) return;
    this.presentationWrites.push({ node, oldValue: node.data });
    node.data = value;
  }

  private acceptHostTextEdits(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type !== "characterData" || this.acceptedTextEdits.has(record)) continue;
      this.acceptedTextEdits.add(record);
      const node = record.target as Text;
      const block = this.hiddenTextOwners.get(node);
      if (!block) continue;
      // Even setting an already-empty Text is an intentional host edit. The
      // observer records distinguish it from our own temporary hiding writes.
      this.hiddenSources.get(block)?.texts.delete(node);
      this.hiddenTextOwners.delete(node);
    }
  }

  private showSource(block: PageBlock): void {
    const hidden = this.hiddenSources.get(block);
    if (!hidden) return;
    this.changePresentation(() => {
      this.hiddenSources.delete(block);
      for (const [node, value] of hidden.texts) {
        this.hiddenTextOwners.delete(node);
        // The host may replace hidden text itself. Never overwrite its new value.
        if (node.data === "") this.setPresentationText(node, value);
      }
      for (const element of hidden.elements) element.removeAttribute(HIDDEN_SOURCE_ATTRIBUTE);
    });
  }

  private applyDisplayMode(block: PageBlock): void {
    if (this.displayMode === "translation-only" && block.status === "completed"
      && block.output?.isConnected) {
      if (this.hiddenSources.has(block)) return;
      if (!canHideRange(block.range)) return;
      this.ensureDisplayStyle();
      this.changePresentation(() => {
        const hidden = { texts: new Map<Text, string>(), elements: [] as HTMLElement[] };
        for (const node of block.range.nodes) {
          if (node.nodeType === node.TEXT_NODE) {
            hidden.texts.set(node as Text, node.textContent ?? "");
            this.hiddenTextOwners.set(node as Text, block);
            this.setPresentationText(node as Text, "");
          } else if (node.nodeType === node.ELEMENT_NODE) {
            const element = node as HTMLElement;
            hidden.elements.push(element);
            element.setAttribute(HIDDEN_SOURCE_ATTRIBUTE, "");
          }
        }
        this.hiddenSources.set(block, hidden);
      });
    } else this.showSource(block);
  }

  private geometryBounds(block: PageBlock): Pick<DOMRect, "top" | "bottom"> | undefined {
    if (this.hiddenSources.has(block)) return sourceRangeBounds(block.range, block.output);
    const source = sourceRangeBounds(block.range);
    const output = block.output?.getBoundingClientRect();
    if (!output || output.width <= 0 || output.height <= 0) return source;
    // The reader may have scrolled into a long streaming translation while its
    // source is already above the window. Include only this range's own output,
    // never its host's nested list/table subtree, when deciding whether to cancel.
    if (!source) return output;
    return { top: Math.min(source.top, output.top), bottom: Math.max(source.bottom, output.bottom) };
  }

  private withOriginalVisibility<T>(read: () => T, candidates: Iterable<PageBlock> = this.hiddenSources.keys()): T {
    if (!this.hiddenSources.size) return read();
    return this.changePresentation(() => {
      const hidden = [...candidates].filter((block) => this.hiddenSources.has(block));
      for (const block of hidden) this.showSource(block);
      try { return read(); }
      finally {
        for (const block of hidden) {
          if (this.isRegistered(block) && rangeStillMatches(block.range)) this.applyDisplayMode(block);
        }
      }
    });
  }

  private beginViewport(): void {
    this.viewportEpoch += 1;
    this.viewportStarted = performance.now();
  }

  private beginReading(fromScroll: boolean): void {
    if (!this.jobId) return;
    this.reading.start(this.jobId, this.blocks, fromScroll, (block) =>
      sourceRangeVisible(block.range, this.hiddenSources.has(block) ? block.output : undefined));
  }

  private checkViewportSettled(): void {
    if (!this.enabled || this.discoveryScheduled || this.settledViewportEpoch === this.viewportEpoch) return;
    const visible = this.blocks.filter((block) => this.viewportRank(block) === 0);
    if (visible.some((block) => block.status === "pending" || block.status === "running")) return;
    this.settledViewportEpoch = this.viewportEpoch;
    this.timings.mark("viewport.settled", { jobId: this.jobId }, {
      sinceSessionMs: performance.now() - this.runStarted,
      durationMs: performance.now() - this.viewportStarted,
      blocks: visible.length,
      failed: visible.filter((block) => block.status === "failed").length,
      epoch: this.viewportEpoch,
    });
  }

  private removeOutputs(): void {
    for (const block of [...this.hiddenSources.keys()]) this.showSource(block);
    for (const output of this.document.querySelectorAll(`[${GENERATED_ATTRIBUTE}]`)) output.remove();
    for (const block of this.blocks) block.output = undefined;
  }

  private async stop(): Promise<void> {
    this.endInitialPass("stopped");
    const oldJob = this.jobId;
    this.reading.end();
    this.generation += 1;
    this.enabled = false;
    this.abortActiveBatches();
    this.failRemaining(this.blocks);
    this.refreshState("stopped");
    if (oldJob) await this.transport.cancel(oldJob).catch(() => undefined);
  }

  private async restore(): Promise<void> {
    this.endInitialPass("stopped");
    const oldJob = this.jobId;
    this.reading.end();
    this.generation += 1;
    this.enabled = false;
    this.abortActiveBatches();
    this.removeOutputs();
    this.blocks = [];
    this.byNode.clear();
    this.jobId = undefined;
    this.settingsRevision = undefined;
    this.state = {
      status: "idle",
      total: 0,
      completed: 0,
      failed: 0,
      message: "已恢复原文。再次翻译时会复用仍有效的本页结果。",
    };
    this.publishState();
    if (oldJob) await this.transport.cancel(oldJob).catch(() => undefined);
  }

  private async cancelCurrent(): Promise<void> {
    const oldJob = this.jobId;
    this.abortActiveBatches();
    if (oldJob && this.state.status === "running") {
      await this.transport.cancel(oldJob).catch(() => undefined);
    }
  }

  private invalidateIfPageChanged(): void {
    if (this.disposed) return;
    if (!this.runUrl || this.currentUrl() === this.runUrl || this.state.status === "idle") return;
    this.endInitialPass("stopped");
    const oldJob = this.jobId;
    this.reading.end();
    this.generation += 1;
    this.enabled = false;
    this.abortActiveBatches();
    this.removeOutputs();
    this.blocks = [];
    this.byNode.clear();
    this.jobId = undefined;
    this.settingsRevision = undefined;
    this.runUrl = this.currentUrl();
    this.state = {
      status: "stopped",
      total: 0,
      completed: 0,
      failed: 0,
      message: "页面已变化，请重新点击翻译正文。",
    };
    this.publishState();
    if (oldJob) void this.transport.cancel(oldJob).catch(() => undefined);
  }

  private scheduleDiscovery(hosts?: Map<HTMLElement, number>): void {
    if (!this.enabled || !this.settingsRevision) return;
    if (!hosts) this.fullDiscovery = true;
    else for (const [host, priority] of hosts) this.dirtyHosts.set(host, priority);
    if (this.discoveryScheduled) return;
    this.discoveryScheduled = true;
    this.discoveryTask = new Promise((resolve) => {
      setTimeout(() => {
        this.discoveryScheduled = false;
        const dirty = this.fullDiscovery ? undefined : this.dirtyHosts;
        this.dirtyHosts = new Map();
        this.fullDiscovery = false;
        // Reconcile the current generation. A restart during the debounce must
        // not swallow new mutations behind the previous generation's timer.
        if (this.enabled && this.settingsRevision) {
          this.reconcileBlocks(this.settingsRevision, dirty);
        }
        resolve();
      }, DYNAMIC_DELAY_MS);
    });
  }

  private reconcileBlocks(settingsRevision: string, dirty?: Map<HTMLElement, number>): void {
    this.invalidateIfPageChanged();
    if (!this.enabled) return;
    const started = performance.now();
    const targets = dirty;
    const reread = targets ? this.withOriginalVisibility(() => collectHostRanges(targets.keys()),
      this.blocks.filter(block => targets.has(block.element))) : undefined;
    // An emptied or newly ineligible root can change fallback scope.
    if (reread && !reread.some(range => range.source.length >= 80)) dirty = undefined;
    let sources: SourceRange[];
    if (dirty && reread) {
      for (const range of reread) range.readingPriority = dirty.get(range.element);
      sources = [...this.blocks.filter(block => !dirty.has(block.element)).map(block => block.range), ...reread];
      sources.sort((a, b) => a.nodes[0] === b.nodes[0] ? 0
        : a.nodes[0].compareDocumentPosition(b.nodes[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    } else sources = this.withOriginalVisibility(() => collectRanges(this.document));
    const keys = new Set(sources.map((range) => range.nodes[0]));
    for (const block of [...this.blocks]) {
      if (!keys.has(block.key)) this.invalidateBlock(block);
    }
    const next: PageBlock[] = [];
    let added = 0;
    for (const range of sources) {
      let block = this.byNode.get(range.nodes[0]);
      if (block && (!sameRange(block.range, range) || block.languageHint !== (range.element.closest("[lang]")?.getAttribute("lang") ?? undefined))) {
        this.invalidateBlock(block);
        block = undefined;
      }
      if (!block) {
        block = this.createBlock(range, settingsRevision);
        added += 1;
      } else if (block.range !== range) {
        // Scope priority may change when an article appears, grows or disappears,
        // even though this source and its original node anchors are unchanged.
        block.range = range;
        if (block.output) this.insertOutput(block, block.output.textContent ?? "", block.status !== "completed");
      }
      next.push(block);
    }
    this.blocks = next;
    this.timings.mark("extraction.dynamic", { jobId: this.jobId }, {
      durationMs: performance.now() - started, candidates: dirty ? reread!.length : sources.length,
      blocks: next.length, added, incremental: !!dirty,
    });
    this.beginViewport();
    this.refreshState(this.runningGeneration === this.generation ? "running" : "watching");
    this.abortDistantBatches();
    this.pump();
  }

  private validateExistingBlocks(records: MutationRecord[]): void {
    if (this.disposed) return;
    this.acceptHostTextEdits(records);
    if (this.state.status === "idle") return;
    if (this.currentUrl() !== this.runUrl) {
      this.invalidateIfPageChanged();
      return;
    }
    // Translation text, wrappers and our display stylesheet must not initiate a
    // source discovery pass. Own display markers are outside attributeFilter.
    const generated = (node: Node): boolean => node.nodeType === 1 && (
      (node as Element).hasAttribute(GENERATED_ATTRIBUTE)
      || (node as Element).hasAttribute(DISPLAY_STYLE_ATTRIBUTE)
      || (node as Element).hasAttribute("data-folio-style")
      || (node as Element).hasAttribute("data-folio-ui")
    );
    const sourceRecords = records.filter((record) => {
      const element = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
      if (element?.closest(`[${GENERATED_ATTRIBUTE}], [${DISPLAY_STYLE_ATTRIBUTE}], [data-folio-style], [data-folio-ui]`)) return false;
      // Changes inside known non-content regions cannot introduce article text.
      // Attribute changes are retained because they can change eligibility.
      if (record.type !== "attributes" && element?.closest("nav, footer, aside, [role~='navigation'], [role~='banner'], [role~='contentinfo'], [role~='complementary']")) return false;
      if (record.type !== "childList") return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) => !generated(node));
    });
    if (!sourceRecords.length) return;
    // Only known, substantial paragraph text edits can keep the current scope.
    // Attributes, replaced nodes, new content, and mixed article/main layouts
    // retain full discovery, including re-evaluation of reading priorities.
    const dirty = new Map<HTMLElement, number>();
    const local = sourceRecords.every(record => {
      if (record.type !== "characterData") return false;
      const block = this.blocks.find(candidate => candidate.element.tagName === "P"
        && candidate.range.nodes.some(node => node === record.target || node.contains(record.target)));
      if (!block || block.source.length < 80 || (record.target.textContent?.trim().length ?? 0) < 80) return false;
      const main = block.element.closest("main, [role~='main']");
      if (main?.querySelector("article") && this.blocks.some(candidate => main.contains(candidate.element)
        && !candidate.element.closest("article"))) return false;
      dirty.set(block.element, block.range.readingPriority ?? 1);
      return true;
    });
    // Invalidate known changed versions immediately, before the coalesced
    // discovery timer. This also cancels shared batches and requeues their peers.
    for (const block of [...this.blocks]) {
      const touched = !this.document.contains(block.element)
        || sourceRecords.some((record) =>
          block.element.contains(record.target)
          || (record.type === "attributes" && record.target.contains(block.element))
          || [...record.addedNodes, ...record.removedNodes].some((node) => node.contains(block.element)),
        );
      if (!touched) continue;
      if (!this.blockStillMatches(block)) {
        this.invalidateBlock(block);
        continue;
      }
      if (block.output) this.insertOutput(block, block.output.textContent ?? "", block.status !== "completed");
    }
    if (this.enabled) this.scheduleDiscovery(local ? dirty : undefined);
    this.refreshState(this.state.status);
  }

  /** First settled pass, not a promise that a dynamic document will never grow. */
  private endInitialPass(status: PageState["status"]): void {
    if (this.initialPassEnded || !this.jobId || !["completed", "paused", "error", "stopped"].includes(status)) return;
    // An empty enabled SPA is still waiting for content, not an instant success.
    if (status === "completed" && this.blocks.length === 0) return;
    this.initialPassEnded = true;
    const count = (state: PageBlock["status"]) => this.blocks.filter((block) => block.status === state).length;
    const completed = count("completed"), skipped = count("skipped"), failed = count("failed");
    const pending = count("pending") + count("running"), invalidated = count("superseded");
    this.timings.mark("session.end", { jobId: this.jobId }, {
      durationMs: performance.now() - this.runStarted, blocks: this.blocks.length,
      completed, skipped, failed, pending, invalidated,
      success: status === "completed" && failed === 0 && pending === 0 && invalidated === 0,
      cancelled: status === "stopped",
    });
  }

  private refreshState(status: PageState["status"], message?: string): void {
    this.endInitialPass(status);
    const total = this.blocks.length;
    const completed = this.blocks.filter((block) => block.status === "completed").length;
    const failed = this.blocks.filter((block) => block.status === "failed").length;
    const skipped = this.blocks.filter((block) => block.status === "skipped").length;
    if (!message && status === "running") {
      if (this.document.visibilityState === "hidden") message = "页面正在后台继续翻译…";
      else if (!this.blocks.some((block) =>
        (block.status === "pending" || block.status === "running") && this.viewportRank(block) === 0)) {
        message = "当前屏幕已翻译，正在继续翻译页面其余正文…";
      }
    }
    this.state = {
      status,
      total,
      completed,
      skipped,
      failed,
      message: message || (status === "completed" && total > 0 && skipped === total
        ? "当前正文已是目标语言，无需翻译；新增正文会自动检查。"
        : status === "watching" && total === 0 ? "等待页面正文出现…" : stateMessage(status, failed)),
    };
    this.checkViewportSettled();
    this.reading.check();
    this.publishState();
  }

  private setState(status: PageState["status"], message?: string): void {
    this.endInitialPass(status);
    this.state = { ...this.state, status, message: message || stateMessage(status, this.state.failed) };
    this.publishState();
  }

  private publishedState = "";
  private publishState(): void {
    if (this.disposed || !this.options.onStateChange) return;
    const key = JSON.stringify(this.state);
    if (key === this.publishedState) return;
    this.publishedState = key;
    this.options.onStateChange({ ...this.state });
  }
}
