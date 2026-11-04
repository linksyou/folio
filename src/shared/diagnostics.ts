/** Bounded local diagnostics: identifiers, stage names and numbers only; never source text or credentials. */
export interface TimingEvent {
  layer: "page" | "background" | "host";
  stage: string;
  atMs: number;
  /** Realm identity: performance.now is only comparable within this clock. */
  clockId?: string;
  /** Each bounded log has its own sequence; a retained first sequence > 1 indicates truncation. */
  logId?: string;
  sequence?: number;
  jobId?: string;
  batchId?: string;
  /** Correlates shared provider work without exposing page text or URLs. */
  providerJobId?: string;
  providerBatchId?: string;
  values?: Record<string, number | boolean>;
}

// randomUUID is unavailable on insecure HTTP pages; getRandomValues is not.
const clockId = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16)).join("-");
let nextLogId = 0;

export class TimingLog {
  private events: TimingEvent[] = [];
  private readonly logId = `${clockId}:${++nextLogId}`;
  private sequence = 0;
  constructor(private readonly layer: TimingEvent["layer"], private readonly limit = 500) {}

  mark(stage: string, identity: Pick<TimingEvent, "jobId" | "batchId" | "providerJobId" | "providerBatchId"> = {}, values?: TimingEvent["values"]): void {
    this.events.push({ layer: this.layer, stage, clockId, logId: this.logId, sequence: ++this.sequence, atMs: Math.round(performance.now() * 10) / 10, ...identity, ...(values ? { values } : {}) });
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }

  read(): TimingEvent[] { return structuredClone(this.events); }
}
