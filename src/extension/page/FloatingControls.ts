import type { PageAction, PageState, Result } from "../../shared/protocol.js";
import { pageError, pageFeedback } from "../../shared/page-feedback.js";

export interface FloatingPosition { edge: "left" | "right"; ratio: number }
export interface FloatingControlsCallbacks {
  iconUrl: string;
  action(action: PageAction): Promise<Result<PageState> | void>;
  openSettings?(): Promise<unknown>;
  savePosition?(position: FloatingPosition): Promise<unknown>;
}

const BUTTON_SIZE = 40;
const MARGIN = 14;
const CSS = `
  :host {
    all: initial;
    position: fixed !important; width: 40px !important; height: 40px !important;
    margin: 0 !important; padding: 0 !important; border: 0 !important;
    z-index: 2147483646 !important;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    direction: ltr !important;
  }
  :host([hidden]) { display: none !important; }
  .trigger {
    box-sizing: border-box; display: grid; place-items: center;
    width: 40px; height: 40px; padding: 6px;
    border: 1px solid #909dac20; border-radius: 12px;
    background: #f8fafcbe; box-shadow: 0 1px 4px #2030470a;
    opacity: .55; cursor: pointer; user-select: none; touch-action: none;
    transition: opacity .16s ease, background .16s ease;
  }
  .trigger:hover, .trigger:focus-visible { opacity: .95; background: #f8fafc; }
  .trigger:focus-visible { outline: 2px solid #85aed9; outline-offset: 3px; }
  .trigger[aria-busy="true"] { cursor: progress; }
  .trigger img { display: block; width: 26px; height: 26px; border-radius: 7px; filter: saturate(.65); pointer-events: none; }
  :host([data-dragging]) .trigger { cursor: grabbing; opacity: .95; }
  .announcement { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(100%); white-space: nowrap; }
  [hidden] { display: none !important; }
  * { box-sizing: border-box; }
  button, summary { font: inherit; cursor: pointer; }
  button { min-height: 32px; border: 1px solid #cbd1da; border-radius: 8px; background: #fff; color: #202124; padding: 5px 9px; }
  button:focus-visible, summary:focus-visible { outline: 2px solid #1769d2; outline-offset: 2px; }
  button:disabled { opacity: .5; cursor: default; }
  .badge { position: absolute; right: 46px; top: 4px; max-width: calc(100vw - 82px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; box-shadow: 0 2px 7px #20304712; }
  :host([data-edge="left"]) .badge { right: auto; left: 46px; }
  .badge[data-problem="true"] { color: #9c3030; border-color: #e8b6b3; }
  .panel { position: fixed; width: min(300px, calc(100vw - 28px)); max-height: calc(100vh - 28px); overflow: auto; overscroll-behavior: contain; padding: 14px; border: 1px solid #e2e5ea; border-radius: 12px; background: #fff; color: #202124; box-shadow: 0 4px 20px #20304724; }
  .heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .heading strong { font-weight: 600; }
  .close { border: 0; font-size: 16px; padding: 2px 8px; }
  p { margin: 8px 0; overflow-wrap: anywhere; }
  .progress { color: #696e78; font-size: 12px; font-variant-numeric: tabular-nums; }
  .primary { width: 100%; margin-top: 4px; background: #1769d2; color: #fff; border-color: #1769d2; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  summary { margin-top: 10px; color: #696e78; }
  details p { color: #696e78; font-size: 12px; }
  @media (prefers-color-scheme: dark) {
    .trigger { background: #dfe5ed0d; border-color: #dfe5ed18; box-shadow: none; opacity: .5; }
    .trigger:hover, .trigger:focus-visible { background: #dfe5ed18; opacity: .9; }
    button, .panel { background: #20242b; color: #e6e9ef; border-color: #48515e; }
    .badge[data-problem="true"] { color: #ffb8b1; border-color: #a96767; }
    .progress, summary, details p { color: #b1b8c4; }
    .primary { background: #287bdd; color: #fff; border-color: #287bdd; }
  }
  @media (prefers-reduced-motion: reduce) { .trigger { transition: none; } }
`;

/** Fixed, non-modal controls; never insert feedback into the article's layout. */
export class FloatingControls {
  private readonly host: HTMLDivElement;
  private readonly trigger: HTMLButtonElement;
  private readonly announcement: HTMLSpanElement;
  private readonly badge: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly message: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly primary: HTMLButtonElement;
  private panelOpen = false;
  private failureKey = "";
  private readonly view: Window;
  private state: PageState = { status: "idle", total: 0, completed: 0, failed: 0, message: "" };
  private stateRevision = 0;
  private position: FloatingPosition = { edge: "right", ratio: .55 };
  private pending = false;
  private disposed = false;
  private enabled = true;
  private top = 0;
  private suppressClick = false;
  private suppressTimer: number | undefined;
  private drag: { id: number; x: number; y: number; top: number; moved: boolean } | undefined;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly document: Document, private readonly callbacks: FloatingControlsCallbacks) {
    if (!document.defaultView) throw new Error("Floating controls require a document window");
    this.view = document.defaultView;
    this.host = document.createElement("div");
    this.host.dataset.folioUi = "floating";
    const root = this.host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style>
      <button class="trigger" type="button" aria-controls="folio-panel"><img alt="" draggable="false" /></button>
      <button class="badge" type="button" aria-controls="folio-panel" hidden></button>
      <section class="panel" id="folio-panel" role="region" aria-label="Folio 翻译状态" hidden>
        <div class="heading"><strong>Folio · 页面翻译</strong><button class="close" type="button" aria-label="关闭翻译面板">×</button></div>
        <p class="message"></p><p class="progress"></p>
        <button class="primary" type="button"></button>
        <div class="actions">
          <button data-action="retry" type="button"></button>
          <button data-action="restore" type="button">恢复原文</button>
          <button data-action="stop" type="button">停止持续翻译</button>
        </div>
        <details><summary>更多操作</summary><p>忽略已有缓存，重新生成全部正文译文。</p><button data-action="retranslate" type="button">全部重新翻译</button></details>
      </section>
      <span class="announcement" role="status" aria-live="polite" aria-atomic="true"></span>`;
    this.trigger = root.querySelector(".trigger")!;
    this.badge = root.querySelector(".badge")!;
    this.panel = root.querySelector(".panel")!;
    this.message = root.querySelector(".message")!;
    this.progress = root.querySelector(".progress")!;
    this.primary = root.querySelector(".primary")!;
    root.querySelector("img")!.src = callbacks.iconUrl;
    this.announcement = root.querySelector(".announcement")!;
    this.listen(this.trigger, "click", (event) => {
      if (this.suppressClick && (event as MouseEvent).detail !== 0) return;
      if (this.state.status === "idle" && !this.pending) void this.perform("start");
      else this.setPanelOpen(!this.panelOpen);
    });
    this.listen(this.badge, "click", () => this.setPanelOpen(!this.panelOpen));
    this.listen(root.querySelector(".close")!, "click", () => this.setPanelOpen(false));
    this.listen(this.primary, "click", () => void this.perform(pageFeedback(this.state).primary));
    this.listen(this.panel.querySelector("details")!, "toggle", () => this.layout());
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      this.listen(button, "click", () => void this.perform(button.dataset.action as PageAction));
    }
    this.listen(this.host, "keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape" && this.panelOpen) {
        event.stopPropagation();
        this.setPanelOpen(false);
      }
    });
    this.listen(this.trigger, "pointerdown", (event) => this.startDrag(event as PointerEvent));
    this.listen(this.view, "pointermove", (event) => this.moveDrag(event as PointerEvent));
    this.listen(this.view, "pointerup", (event) => this.finishDrag(event as PointerEvent));
    this.listen(this.view, "pointercancel", (event) => this.finishDrag(event as PointerEvent, true));
    this.listen(this.view, "resize", () => this.layout());
    document.documentElement.append(this.host);
    this.layout();
    this.render();
  }

  update(state: PageState): void {
    if (this.disposed) return;
    this.stateRevision += 1;
    this.state = { ...state };
    const feedback = pageFeedback(state);
    const key = feedback.problem ? `${state.error?.code}:${state.failed}` : "";
    if (key && key !== this.failureKey && !feedback.working) this.panelOpen = true;
    if (!feedback.working) this.failureKey = key;
    if (state.status === "idle") { this.panelOpen = false; this.failureKey = ""; }
    this.render();
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    this.host.hidden = !enabled;
  }

  setPosition(position: FloatingPosition): void {
    if (this.disposed) return;
    this.position = {
      edge: position.edge === "left" ? "left" : "right",
      ratio: Number.isFinite(position.ratio) ? Math.max(0, Math.min(1, position.ratio)) : .55,
    };
    this.layout();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanup) cleanup();
    if (this.suppressTimer !== undefined) this.view.clearTimeout(this.suppressTimer);
    this.host.remove();
  }

  private listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.cleanup.push(() => target.removeEventListener(type, listener));
  }

  private setPanelOpen(open: boolean): void {
    // Only return focus when the reader explicitly closes a focused control.
    if (!open && this.panel.contains(this.host.shadowRoot!.activeElement)) this.trigger.focus({ preventScroll: true });
    this.panelOpen = open;
    this.render();
  }

  private render(): void {
    const feedback = pageFeedback(this.state);
    const label = this.state.status === "idle" ? "翻译此页" : "查看翻译状态";
    this.trigger.dataset.status = this.state.status;
    this.trigger.setAttribute("aria-label", label);
    this.trigger.setAttribute("aria-expanded", String(this.panelOpen));
    this.trigger.setAttribute("aria-busy", String(this.pending));
    this.trigger.title = this.pending ? "正在处理…" : label;
    this.badge.hidden = this.state.status === "idle" && !this.pending;
    this.badge.textContent = this.pending ? "正在处理…" : feedback.working
      ? `已翻译 ${this.state.completed} / ${this.state.total} 段`
      : feedback.problem ? this.state.failed ? `${this.state.failed} 段失败 · 查看` : "翻译受阻 · 查看"
      : this.state.status === "stopped" ? "已停止 · 查看"
      : this.state.completed ? `已翻译 ${this.state.completed} / ${this.state.total} 段`
      : this.state.skipped ? `${this.state.skipped} 段无需翻译` : "等待正文 · 查看";
    this.badge.dataset.problem = String(feedback.problem);
    this.badge.setAttribute("aria-expanded", String(this.panelOpen));
    this.panel.hidden = !this.panelOpen;
    this.message.textContent = feedback.message;
    this.progress.textContent = feedback.progress;
    this.progress.hidden = this.state.total === 0 || feedback.problem && !feedback.working && this.state.completed > 0;
    this.primary.textContent = feedback.label;
    this.primary.disabled = this.pending;
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      const action = button.dataset.action;
      button.disabled = this.pending;
      button.hidden = action === feedback.primary;
      if (action === "retry") {
        button.hidden = !feedback.settings || feedback.working;
        button.textContent = feedback.retryLabel;
      }
      if (action === "restore") button.hidden ||= this.state.total === 0;
      if (action === "stop") button.hidden ||= !feedback.stoppable;
      if (action === "retranslate") button.disabled ||= feedback.working;
    }
    this.panel.querySelector("details")!.hidden = this.state.total === 0;
    this.announcement.textContent = feedback.working ? feedback.progress : feedback.message;
    this.layout();
  }

  private async perform(action: PageAction | "settings"): Promise<void> {
    if (this.pending || this.disposed || !this.enabled) return;
    const revision = this.stateRevision;
    this.pending = true;
    this.announcement.textContent = "";
    this.render();
    try {
      if (action === "settings") {
        await this.callbacks.openSettings?.();
        return;
      }
      const result = await this.callbacks.action(action);
      if (this.disposed) return;
      if (result?.ok && revision === this.stateRevision) this.update(result.result);
      else if (result && !result.ok && revision === this.stateRevision) this.showError(result.error.code);
    } catch {
      if (!this.disposed && revision === this.stateRevision) this.showError("EXTENSION_ERROR");
    } finally {
      this.pending = false;
      if (!this.disposed) this.render();
    }
  }

  private showError(code: string): void {
    this.update({ ...this.state, status: "paused", continuing: false, error: pageError({ code }) });
  }

  private layout(): void {
    const span = Math.max(0, this.view.innerHeight - BUTTON_SIZE - MARGIN * 2);
    this.top = MARGIN + this.position.ratio * span;
    this.host.dataset.edge = this.position.edge;
    this.host.style.setProperty("top", `${this.top}px`, "important");
    this.host.style.setProperty("left", this.position.edge === "left" ? `${MARGIN}px` : "auto", "important");
    this.host.style.setProperty("right", this.position.edge === "right" ? `${MARGIN}px` : "auto", "important");
    this.panel.style.left = this.position.edge === "left" ? `${MARGIN}px` : "auto";
    this.panel.style.right = this.position.edge === "right" ? `${MARGIN}px` : "auto";
    const below = this.top + BUTTON_SIZE + 8;
    const panelTop = below + this.panel.offsetHeight <= this.view.innerHeight - MARGIN
      ? below : this.top - this.panel.offsetHeight - 8;
    this.panel.style.top = `${Math.max(MARGIN, panelTop)}px`;
  }

  private startDrag(event: PointerEvent): void {
    if (event.button !== 0 || this.disposed || !this.enabled) return;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, top: this.top, moved: false };
    this.trigger.setPointerCapture?.(event.pointerId);
  }

  private moveDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    drag.moved = true;
    event.preventDefault();
    this.host.dataset.dragging = "";
    this.top = Math.max(MARGIN, Math.min(this.view.innerHeight - BUTTON_SIZE - MARGIN, drag.top + event.clientY - drag.y));
    const left = Math.max(MARGIN, Math.min(this.view.innerWidth - BUTTON_SIZE - MARGIN, event.clientX - BUTTON_SIZE / 2));
    this.host.style.setProperty("top", `${this.top}px`, "important");
    this.host.style.setProperty("left", `${left}px`, "important");
    this.host.style.setProperty("right", "auto", "important");
  }

  private finishDrag(event: PointerEvent, cancelled = false): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.id) return;
    this.drag = undefined;
    delete this.host.dataset.dragging;
    if (this.trigger.hasPointerCapture?.(event.pointerId)) this.trigger.releasePointerCapture(event.pointerId);
    if (cancelled || !drag.moved) { this.layout(); return; }
    this.suppressClick = true;
    this.suppressTimer = this.view.setTimeout(() => { this.suppressClick = false; }, 0);
    const span = Math.max(1, this.view.innerHeight - BUTTON_SIZE - MARGIN * 2);
    this.setPosition({ edge: event.clientX < this.view.innerWidth / 2 ? "left" : "right", ratio: (this.top - MARGIN) / span });
    void this.callbacks.savePosition?.({ ...this.position }).catch(() => {});
  }
}
