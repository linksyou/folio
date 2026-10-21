import { channel } from "node:diagnostics_channel";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { ChatGPTAuth } from "../src/host/auth/index.js";
import { ModelProviders } from "../src/host/providers.js";
import { HostService } from "../src/host/service.js";
import { SettingsStore } from "../src/host/settings.js";
import type { Translation } from "../src/shared/protocol.js";
import { createHttpTransport } from "../src/host/http.js";

// Explicit diagnostic command: sends only a fixed public sentence using the
// saved configuration. Never serialize credentials, headers, or response text.
const args = process.argv.slice(2).filter((arg) => !["--default-fetch", "--prepare"].includes(arg));
const useDefaultFetch = process.argv.includes("--default-fetch");
const prepareFirst = process.argv.includes("--prepare");
if (prepareFirst && useDefaultFetch) throw new Error("--prepare 需要生产连接池，不能与 --default-fetch 同用。");
const samples = Number(args[0] ?? 2);
const pauseMs = Number(args[1] ?? 0);
if (args.length > 2 || !Number.isInteger(samples) || samples < 1 || samples > 5) {
  throw new Error("样本数量必须为 1–5；每个样本会发送一次真实模型请求。");
}
if (!Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 30_000) {
  throw new Error("样本间隔必须为 0–30000 毫秒。");
}
const dataDir = process.env.OPEN_WEB_TRANSLATOR_DATA_DIR ??
  join(homedir(), ".local/share/open-web-translator/data");
const http = createHttpTransport();
interface Sample {
  index: number;
  ok?: boolean;
  timingsMs: Record<string, number>;
  localCalls: Array<{ stage: string; durationMs: number }>;
  network: Array<{ kind: "auth" | "model"; headersMs: number; status: number }>;
  connections: Array<Record<string, number | string>>;
  request?: { model: string; effort?: string; stream: boolean };
  usage?: { input: number; output: number; reasoning?: number; cached?: number };
  processingHeaderMs?: number;
  preparationReady?: boolean;
  firstTextAfterClickMs?: number;
  errorCode?: string;
}
let active: Sample | undefined;
let startedAt = 0;
const now = () => Math.round((performance.now() - startedAt) * 10) / 10;
const mark = (name: string) => { if (active) active.timingsMs[name] ??= now(); };
async function timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await fn(); }
  finally { active?.localCalls.push({ stage, durationMs: Math.round((performance.now() - start) * 10) / 10 }); }
}

// Network events expose objects with secrets; copy only timing information.
const requests = new WeakSet<object>();
const sockets = new WeakMap<Socket, Record<string, number | string>>();
const subscriptions: Array<() => void> = [];
function subscribe(name: string, listener: (message: any) => void): void {
  const target = channel(name);
  target.subscribe(listener);
  subscriptions.push(() => target.unsubscribe(listener));
}
subscribe("undici:request:create", ({ request }) => {
  if (!active || request.origin !== "https://api.openai.com" || request.path !== "/v1/responses") return;
  requests.add(request);
  mark("requestCreated");
});
subscribe("net.client.socket", ({ socket }: { socket: Socket }) => {
  if (!active) return;
  const origin = startedAt;
  const elapsed = () => Math.round((performance.now() - origin) * 10) / 10;
  const connection: Record<string, number | string> = { started: now() };
  active.connections.push(connection);
  sockets.set(socket, connection);
  socket.once("lookup", () => { connection.dnsDone = elapsed(); });
  socket.once("connect", () => { connection.tcpConnected = elapsed(); });
  socket.once("secureConnect", () => { connection.tlsConnected = elapsed(); });
  socket.once("close", () => { connection.closed = elapsed(); });
});
subscribe("undici:client:sendHeaders", ({ request, socket }) => {
  if (!requests.has(request)) return;
  mark("requestSent");
  const connection = sockets.get(socket);
  if (connection) connection.usedByModel = 1;
});
subscribe("undici:client:connected", ({ socket }: { socket: TLSSocket }) => {
  const connection = sockets.get(socket);
  if (!connection) return;
  connection.alpn = socket.alpnProtocol || "http/1.1";
  connection.tls = socket.getProtocol() ?? "unknown";
  connection.resumed = Number(socket.isSessionReused());
});
subscribe("undici:request:bodySent", ({ request }) => {
  if (requests.has(request)) mark("bodySent");
});
subscribe("undici:request:headers", ({ request }) => {
  if (requests.has(request)) mark("responseHeaders");
});

const measuredFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const modelRequest = url.origin === "https://api.openai.com" && url.pathname === "/v1/responses";
  const start = performance.now();
  if (modelRequest) {
    mark("fetchCalled");
    const body = JSON.parse(String(init?.body));
    active!.request = { model: body.model, effort: body.reasoning?.effort, stream: body.stream };
  }
  const response = await (useDefaultFetch ? fetch : http.fetch)(input, init);
  active?.network.push({
    kind: modelRequest ? "model" : "auth", status: response.status,
    headersMs: Math.round((performance.now() - start) * 10) / 10,
  });
  if (!modelRequest || !response.body) return response;
  const processing = response.headers.get("openai-processing-ms");
  if (processing && Number.isFinite(Number(processing))) active!.processingHeaderMs = Number(processing);
  const decoder = new TextDecoder();
  let buffer = "";
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      mark("firstBodyChunk");
      buffer += decoder.decode(chunk, { stream: true });
      let end: RegExpExecArray | null;
      while ((end = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data);
          if (["response.created", "response.in_progress", "response.output_text.delta", "response.completed"].includes(event.type)) {
            mark(event.type);
          }
          if (event.type === "response.completed" && event.response?.usage) {
            const usage = event.response.usage;
            active!.usage = {
              input: usage.input_tokens, output: usage.output_tokens,
              reasoning: usage.output_tokens_details?.reasoning_tokens,
              cached: usage.input_tokens_details?.cached_tokens,
            };
          }
        } catch { /* The production parser reports malformed responses. */ }
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, headers: response.headers });
};
class MeasuredAuth extends ChatGPTAuth {
  override status() { return timed("auth.status", () => super.status()); }
  override accessToken(signal?: AbortSignal) {
    return timed("auth.accessToken", () => super.accessToken(signal));
  }
}
class MeasuredSettings extends SettingsStore {
  override read() { return timed("settings.read", () => super.read()); }
}
class MeasuredProviders extends ModelProviders {
  override translate(...args: Parameters<ModelProviders["translate"]>): Promise<Translation[]> {
    mark("providerStarted"); // Includes host queue + configuration checks up to here.
    return super.translate(...args);
  }
}
const auth = new MeasuredAuth({ dataDir, fetch: measuredFetch });
const service = new HostService(
  new MeasuredSettings(dataDir), auth, new MeasuredProviders(auth, measuredFetch, undefined, http.prepare),
);
const result: Sample[] = [];
try {
  for (let index = 0; index < samples; index++) {
    if (index && pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    startedAt = performance.now();
    active = { index: index + 1, timingsMs: {}, localCalls: [], network: [], connections: [] };
    result.push(active);
    try {
      const status = await service.status();
      mark("statusReady");
      if (status.settings.provider !== "chatgpt") throw new Error("此诊断目前仅支持当前已选择 ChatGPT 的配置。");
      if (prepareFirst) {
        mark("preparationStarted");
        const preparation = await service.handle({ type: "connection.prepare" }) as { ready: boolean };
        active.preparationReady = preparation.ready;
        mark("preparationFinished");
      }
      mark("translateClicked");
      await service.handle({
        type: "translate", jobId: `diagnostic-${crypto.randomUUID()}`, batchId: "single",
        settingsRevision: status.settingsRevision,
        blocks: [{ id: "probe", text: "Welcome to your bilingual reading space." }],
      }, () => mark("firstProgress"));
      if (active.timingsMs.firstProgress !== undefined) {
        active.firstTextAfterClickMs = Math.round(
          (active.timingsMs.firstProgress - active.timingsMs.translateClicked!) * 10,
        ) / 10;
      }
      active.ok = true;
    } catch (error) {
      active.ok = false;
      active.errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "DIAGNOSTIC_FAILED";
    }
    mark("finished");
    console.log(JSON.stringify(active));
    if (!active.ok) break;
  }
} finally {
  active = undefined;
  service.close();
  await http.close();
  for (const unsubscribe of subscriptions) unsubscribe();
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/latency-diagnostic.json", JSON.stringify({
    measuredAt: new Date().toISOString(), node: process.versions.node,
    transport: useDefaultFetch ? "node-default" : "explicit-pool", prepareFirst, pauseMs, samples: result,
    note: "Sequential fixed-text samples through HostService; excludes browser IPC and process startup. Post-send wait includes remote/network latency, not isolated GPU compute.",
  }, null, 2));
  if (result.some((sample) => !sample.ok)) process.exitCode = 1;
}
