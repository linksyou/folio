import { Agent, EnvHttpProxyAgent, Pool, type Dispatcher } from "undici";
import type { ProxySettings } from "./proxy.js";

interface DispatcherRequestInit extends RequestInit {
  dispatcher: Dispatcher;
}

const PREPARE_TIMEOUT_MS = 8_000;
const FOREGROUND_PREPARE_WAIT_MS = 250;
const MAX_PREPARE_BODY_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 2;

export interface HttpTransportOptions {
  /** Foreground requests wait briefly for reuse, then supersede a slow probe. */
  foregroundPrepareWaitMs?: number;
  /** Omit to use Undici's environment proxy settings. Native hosts also resolve OS settings. */
  proxy?: ProxySettings;
}

interface Preparation {
  promise: Promise<boolean>;
  controller: AbortController;
}

export interface HttpTransport {
  fetch: typeof globalThis.fetch;
  prepare(origin: string, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}

function originOf(input: string | URL | Request): string | undefined {
  try {
    return new URL(input instanceof Request ? input.url : input).origin;
  } catch {
    return undefined;
  }
}

function requestSignal(input: string | URL | Request, init?: RequestInit): AbortSignal | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function drainPrepareResponse(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        return;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PREPARE_BODY_BYTES) {
        throw new Error("prepare response exceeded the size limit");
      }
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** A host-local connection pool. It never changes Undici's global dispatcher. */
export function createHttpTransport(options: HttpTransportOptions = {}): HttpTransport {
  const foregroundPrepareWaitMs = options.foregroundPrepareWaitMs ?? FOREGROUND_PREPARE_WAIT_MS;
  if (!Number.isFinite(foregroundPrepareWaitMs) || foregroundPrepareWaitMs < 0) {
    throw new RangeError("foregroundPrepareWaitMs must be a finite non-negative number");
  }
  const connections = new Map<string, number>();
  const poolOptions: Agent.Options = {
    connections: MAX_CONNECTIONS,
    allowH2: true,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 60_000,
    // HTTP/2 sessions use PING rather than the HTTP/1 parser idle timeout.
    pingInterval: 60_000,
    // EnvHttpProxyAgent does not forward connection events. Track the actual
    // destination pools so preparation still sees reusable proxied connections.
    factory(origin, options) {
      const pool = new Pool(origin, options);
      pool.on("connect", (url) => {
        connections.set(url.origin, (connections.get(url.origin) ?? 0) + 1);
      });
      pool.on("disconnect", (url) => {
        const count = (connections.get(url.origin) ?? 1) - 1;
        if (count > 0) connections.set(url.origin, count);
        else connections.delete(url.origin);
      });
      return pool;
    },
  };
  const { bypass, ...proxyOptions } = options.proxy ?? {};
  const proxyDispatcher = new EnvHttpProxyAgent({ ...poolOptions, ...proxyOptions });
  const bypassDispatcher = bypass ? new Agent(poolOptions) : undefined;
  // Select per dispatch, including redirects performed internally by fetch.
  const dispatcher = bypass && bypassDispatcher
    ? proxyDispatcher.compose((dispatch) => (request, handler) =>
      request.origin && bypass(new URL(request.origin))
        ? bypassDispatcher.dispatch(request, handler) : dispatch(request, handler))
    : proxyDispatcher;
  const activeFetches = new Map<string, number>();
  const preparations = new Map<string, Preparation>();

  const directFetch: typeof globalThis.fetch = (input, init) => {
    const requestInit: DispatcherRequestInit = { ...init, dispatcher };
    return globalThis.fetch(input, requestInit);
  };

  const trackedFetch: typeof globalThis.fetch = async (input, init) => {
    const origin = originOf(input);
    if (origin) activeFetches.set(origin, (activeFetches.get(origin) ?? 0) + 1);
    try {
      return await directFetch(input, init);
    } finally {
      if (origin) {
        const count = (activeFetches.get(origin) ?? 1) - 1;
        if (count > 0) activeFetches.set(origin, count);
        else activeFetches.delete(origin);
      }
    }
  };

  const prepare = async (originInput: string, signal?: AbortSignal): Promise<boolean> => {
    signal?.throwIfAborted();
    const origin = new URL(originInput).origin;
    let preparation = preparations.get(origin);
    if (preparation) {
      return waitFor(preparation.promise, signal);
    }
    if (connections.has(origin)) return true;
    if (activeFetches.has(origin)) return false;
    const controller = new AbortController();
    // A cold pool has two request slots. Preparing only one left the second
    // concurrent model POST waiting for its own TLS handshake, including on H2.
    // Existing connections/ordinary work above remain untouched; ready means
    // at least one reusable connection, not that both probes succeeded.
    const probeSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(PREPARE_TIMEOUT_MS)]);
    const probe = async (): Promise<boolean> => {
      const response = await directFetch(`${origin}/`, {
        method: "OPTIONS", redirect: "manual", signal: probeSignal,
      });
      // Any HTTP status proves transport connectivity. Drain each response so
      // HTTP/1 releases both slots; never send credentials, a body or redirects.
      await drainPrepareResponse(response);
      return response.headers.get("connection")?.toLowerCase() !== "close";
    };
    let task!: Promise<boolean>;
    task = (async () => {
      try {
        // One deadline and controller cover both probes. Wait for both cleanup
        // paths before foreground work takes over, even if one probe fails.
        const results = await Promise.allSettled(Array.from({ length: MAX_CONNECTIONS }, probe));
        await new Promise<void>((resolve) => setImmediate(resolve));
        // Foreground work may supersede the shared probe. Its waiters receive
        // not-ready; aborting an individual waiter never reaches this controller.
        if (controller.signal.aborted) return false;
        if (results.some((result) => result.status === "fulfilled" && result.value)) return connections.has(origin);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        return false;
      } finally {
        if (preparations.get(origin)?.promise === task) preparations.delete(origin);
      }
    })();
    preparations.set(origin, { promise: task, controller });
    return waitFor(task, signal);
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const origin = originOf(input);
    const preparation = origin ? preparations.get(origin) : undefined;
    if (preparation) {
      const signal = requestSignal(input, init);
      signal?.throwIfAborted();
      // The probe has its own longer lifetime, but must not hold a real request
      // behind slow OPTIONS headers or a body that never ends. Abort the probe
      // after the foreground budget, wait for its cleanup, then dispatch once.
      const timer = setTimeout(() => {
        if (!signal?.aborted) preparation.controller.abort();
      }, foregroundPrepareWaitMs);
      try {
        await waitFor(preparation.promise, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        // Warming is opportunistic. The real request remains the source of truth.
      } finally {
        clearTimeout(timer);
      }
    }
    return trackedFetch(input, init);
  };

  return {
    fetch,
    prepare,
    async close(): Promise<void> {
      await Promise.all([dispatcher.destroy(), bypassDispatcher?.destroy()]);
    },
  };
}
