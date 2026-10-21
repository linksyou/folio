/** Bounded local diagnostics: identifiers, stage names and numbers only; never source text or credentials. */
export interface TimingEvent {
  layer: "page" | "background" | "host";
  stage: string;
  atMs: number;
  jobId?: string;
  batchId?: string;
  /** Correlates shared provider work without exposing page text or URLs. */
  providerJobId?: string;
  providerBatchId?: string;
  values?: Record<string, number | boolean>;
}

export class TimingLog {
  private events: TimingEvent[] = [];
  constructor(private readonly layer: TimingEvent["layer"], private readonly limit = 500) {}

  mark(stage: string, identity: Pick<TimingEvent, "jobId" | "batchId" | "providerJobId" | "providerBatchId"> = {}, values?: TimingEvent["values"]): void {
    this.events.push({ layer: this.layer, stage, atMs: Math.round(performance.now() * 10) / 10, ...identity, ...(values ? { values } : {}) });
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
  }

  read(): TimingEvent[] { return structuredClone(this.events); }
}
