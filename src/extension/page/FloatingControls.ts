import type { PageAction, PageState, Result } from "../../shared/protocol.js";

export interface FloatingPosition { edge: "left" | "right"; ratio: number }
export interface FloatingControlsCallbacks {
  iconUrl: string;
  action(action: PageAction): Promise<Result<PageState> | void>;
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
  @media (prefers-color-scheme: dark) {
    .trigger { background: #dfe5ed0d; border-color: #dfe5ed18; box-shadow: none; opacity: .5; }
    .trigger:hover, .trigger:focus-visible { background: #dfe5ed18; opacity: .9; }
  }
  @media (prefers-reduced-motion: reduce) { .trigger { transition: none; } }
`;

/** One quiet page toggle. Translation, cancellation and restoration stay in the existing pipeline. */
export class FloatingControls {
  private readonly host: HTMLDivElement;
  private readonly trigger: HTMLButtonElement;
  private readonly announcement: HTMLSpanElement;
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
    this.host.dataset.openWebTranslatorUi = "floating";
    const root = this.host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><button class="trigger" type="button"><img alt="" draggable="false" /></button><span class="announcement" role="status" aria-live="polite"></span>`;
    this.trigger = root.querySelector("button")!;
    root.querySelector("img")!.src = callbacks.iconUrl;
    this.announcement = root.querySelector(".announcement")!;
    this.listen(this.trigger, "click", (event) => {
      if (this.suppressClick && (event as MouseEvent).detail !== 0) return;
      void this.toggle();
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

  private showingTranslation(): boolean {
    // A running job may already have provisional text, even with zero completed blocks.
    return ["running", "watching", "completed"].includes(this.state.status) || this.state.completed > 0;
  }

  private render(): void {
    const translated = this.showingTranslation();
    const label = translated ? "显示原文" : "翻译此页";
    this.trigger.dataset.status = this.state.status;
    this.trigger.setAttribute("aria-label", label);
    this.trigger.setAttribute("aria-pressed", String(translated));
    this.trigger.setAttribute("aria-busy", String(this.pending));
    this.trigger.title = this.pending ? "正在处理…" : label;
  }

  private async toggle(): Promise<void> {
    if (this.pending || this.disposed || !this.enabled) return;
    const action = this.showingTranslation() ? "restore" : "start";
    const revision = this.stateRevision;
    this.pending = true;
    this.announcement.textContent = "";
    this.render();
    try {
      const result = await this.callbacks.action(action);
      if (this.disposed) return;
      if (result?.ok && revision === this.stateRevision) this.update(result.result);
      else if (result && !result.ok) this.showError(result.error.message);
    } catch {
      if (!this.disposed) this.showError("操作未完成，请重试或在工具栏中查看连接设置。");
    } finally {
      this.pending = false;
      if (!this.disposed) {
        const error = this.announcement.textContent;
        this.render();
        if (error) this.trigger.title = error;
      }
    }
  }

  private showError(message: string): void {
    this.announcement.textContent = message;
  }

  private layout(): void {
    const span = Math.max(0, this.view.innerHeight - BUTTON_SIZE - MARGIN * 2);
    this.top = MARGIN + this.position.ratio * span;
    this.host.dataset.edge = this.position.edge;
    this.host.style.setProperty("top", `${this.top}px`, "important");
    this.host.style.setProperty("left", this.position.edge === "left" ? `${MARGIN}px` : "auto", "important");
    this.host.style.setProperty("right", this.position.edge === "right" ? `${MARGIN}px` : "auto", "important");
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
