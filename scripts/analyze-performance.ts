import { readFile, writeFile } from "node:fs/promises";
import { aggregatePerformance, summarizePerformance, type Conditions, type PerformanceTrace } from "../src/shared/performance-report.js";

const args = process.argv.slice(2);
const input = args.shift();
if (!input || input.startsWith("--")) throw new Error("Usage: npx tsx scripts/analyze-performance.ts input.json [--output report.json] [--job ID] [--connection cold|warm|unknown] [--cache miss|hit|partial|disabled|unknown] [--source mock|live|unknown] [--scenario ID]");
let output: string | undefined, jobId: string | undefined;
const conditions: Conditions = {};
while (args.length) {
  const flag = args.shift(), value = args.shift();
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  if (flag === "--output") output = value;
  else if (flag === "--job") jobId = value;
  else if (flag === "--scenario") conditions.scenarioId = value;
  else if (flag === "--source" && ["mock", "live", "unknown"].includes(value)) conditions.source = value as Conditions["source"];
  else if (flag === "--connection" && ["cold", "warm", "unknown"].includes(value)) conditions.connection = value as Conditions["connection"];
  else if (flag === "--cache" && ["miss", "hit", "partial", "disabled", "unknown"].includes(value)) conditions.cache = value as Conditions["cache"];
  else throw new Error(`Unknown option or invalid value: ${flag}`);
}
const parsed: unknown = JSON.parse(await readFile(input, "utf8"));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const candidates: unknown[] = Array.isArray(parsed) ? parsed : object(parsed) && Array.isArray(parsed.traces) ? parsed.traces : [parsed];
const traces = candidates.map((value, index): PerformanceTrace => {
  if (!object(value) || !Array.isArray(value.page)
    || ["background", "host"].some((layer) => value[layer] !== undefined && !Array.isArray(value[layer]))) {
    throw new Error(`Invalid trace at index ${index}: expected page event array and optional background/host arrays, or a wrapper containing traces[].`);
  }
  for (const layer of ["page", "background", "host"]) {
    const events = (value[layer] ?? []) as unknown[];
    if (events.some((event) => !object(event) || event.layer !== layer || typeof event.stage !== "string"
      || typeof event.atMs !== "number" || !Number.isFinite(event.atMs))) {
      throw new Error(`Invalid ${layer} events in trace ${index}: each event needs matching layer, stage and finite atMs.`);
    }
  }
  return value as unknown as PerformanceTrace;
});
const reports = traces.map((trace) => summarizePerformance(trace, { jobId, conditions }));
const json = JSON.stringify({ schemaVersion: 1, reports, aggregate: aggregatePerformance(reports) }, null, 2) + "\n";
if (output) await writeFile(output, json);
process.stdout.write(json);
