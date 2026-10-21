import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { createHttpTransport } from "../src/host/http.js";

interface RequestRecord {
  method: string;
  url: string;
  authorization?: string;
  bodyBytes: number;
  connectionId: number;
}

interface LocalServer {
  server: Server;
  origin: string;
  sockets: Set<Socket>;
  requests: RequestRecord[];
  connectionCount(): number;
}

interface LocalServerOptions {
  probeGate?: Promise<void>;
  probeBodyGate?: Promise<void>;
  failProbe?: boolean;
  closeProbeConnection?: boolean;
  probeBehavior?: (index: number) => Pick<LocalServerOptions, "probeGate" | "probeBodyGate" | "failProbe" | "closeProbeConnection">;
  postGate?: Promise<void>;
}

async function localServer(t: TestContext, options: LocalServerOptions = {}): Promise<LocalServer> {
  const sockets = new Set<Socket>();
  const connectionIds = new WeakMap<Socket, number>();
  let connections = 0;
  let probes = 0;
  const pending = new Set<ServerResponse>();
  const requests: RequestRecord[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let bodyBytes = 0;
      for await (const chunk of request) bodyBytes += (chunk as Buffer).byteLength;
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        bodyBytes,
        connectionId: connectionIds.get(request.socket) ?? 0,
      });
      if (request.method === "OPTIONS") {
        const behavior = options.probeBehavior?.(++probes) ?? options;
        if (behavior.probeGate) await behavior.probeGate;
        if (response.destroyed) return;
        if (behavior.failProbe) {
          request.socket.destroy();
          return;
        }
        response.writeHead(401, behavior.closeProbeConnection ? { connection: "close" } : undefined);
        if (behavior.probeBodyGate) {
          response.write("warming");
          await behavior.probeBodyGate;
          if (response.destroyed) return;
        }
        response.end();
        return;
      }
      if (request.method === "POST" && options.postGate) await options.postGate;
      if (request.url === "/pending") {
        pending.add(response);
        response.on("close", () => pending.delete(response));
        return;
      }
      // Omit a server Keep-Alive timeout hint: the client must use its own idle
      // policy, otherwise the hint could hide a regression to the old default.
      response.writeHead(200, { "content-type": "text/plain", connection: "keep-alive" });
      response.end("ok");
    })();
  });
  server.keepAliveTimeout = 20_000;
  server.on("connection", (socket) => {
    connections++;
    connectionIds.set(socket, connections);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  t.after(async () => {
    for (const response of pending) response.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    sockets,
    requests,
    connectionCount: () => connections,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("condition was not reached");
}

test("transport reuses one TCP connection beyond Node fetch's short idle default", async (t) => {
  const local = await localServer(t);
  const transport = createHttpTransport();
  t.after(() => transport.close());

  const request = new Request(`${local.origin}/first`, { headers: { "x-transport-test": "global-request" } });
  const first = await transport.fetch(request);
  assert.equal(first.headers.get("keep-alive"), null);
  assert.equal(await first.text(), "ok");
  await delay(6_500);
  assert.equal(await (await transport.fetch(`${local.origin}/second`)).text(), "ok");

  assert.equal(local.connectionCount(), 1);
  assert.equal(local.sockets.size, 1);
});

test("transport preserves AbortSignal cancellation and remains usable", async (t) => {
  const local = await localServer(t);
  const transport = createHttpTransport();
  t.after(() => transport.close());
  const controller = new AbortController();
  const pending = transport.fetch(`${local.origin}/pending`, { signal: controller.signal });
  await new Promise<void>((resolve) => local.server.once("request", () => resolve()));

  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(await (await transport.fetch(`${local.origin}/after-abort`)).text(), "ok");
});

test("cold prepare warms two private connections in one flight, and a real fetch waits for both", async (t) => {
  const gate = deferred();
  const local = await localServer(t, { probeGate: gate.promise });
  const transport = createHttpTransport();
  t.after(() => transport.close());

  const first = transport.prepare(local.origin);
  await waitUntil(() => local.requests.filter((request) => request.method === "OPTIONS").length === 2);
  let secondFinished = false;
  const second = transport.prepare(`${local.origin}/ignored-path`).finally(() => { secondFinished = true; });
  const click = transport.fetch(`${local.origin}/click`, { method: "POST", body: "translate" });
  await delay(20);

  assert.equal(local.requests.filter((request) => request.method === "OPTIONS").length, 2);
  assert.equal(secondFinished, false);
  assert.equal(local.requests.some((request) => request.url === "/click"), false);
  assert.equal(local.connectionCount(), 2);
  for (const probe of local.requests.filter((request) => request.method === "OPTIONS")) {
    assert.equal(probe.url, "/");
    assert.equal(probe.authorization, undefined);
    assert.equal(probe.bodyBytes, 0);
  }

  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(await (await click).text(), "ok");
  assert.equal(local.connectionCount(), 2);
});

test("one failed cold probe still reports the other reusable connection", async (t) => {
  const local = await localServer(t, { probeBehavior: (index) => ({ failProbe: index === 1 }) });
  const transport = createHttpTransport();
  t.after(() => transport.close());

  assert.equal(await transport.prepare(local.origin), true);
  assert.equal(local.requests.filter((request) => request.method === "OPTIONS").length, 2);
  await waitUntil(() => local.sockets.size === 1);
  // Ready promises some transport capacity, not two successful probes. An
  // already connected origin is not topped up by another background probe.
  assert.equal(await transport.prepare(local.origin), true);
  assert.equal(local.requests.filter((request) => request.method === "OPTIONS").length, 2);
  assert.equal(await (await transport.fetch(`${local.origin}/after-partial-failure`)).text(), "ok");
});

test("a completed probe does not hide the other slow probe from foreground cancellation", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const local = await localServer(t, { probeBehavior: (index) => index === 2 ? { probeBodyGate: gate.promise } : {} });
  const transport = createHttpTransport({ foregroundPrepareWaitMs: 25 });
  t.after(() => transport.close());
  let settled = false;
  const preparation = transport.prepare(local.origin).finally(() => { settled = true; });
  await waitUntil(() => local.requests.filter((request) => request.method === "OPTIONS").length === 2);
  await delay(20);
  assert.equal(settled, false);

  const real = transport.fetch(`${local.origin}/after-partial-slow`, { method: "POST", body: "translation" });
  await waitUntil(() => local.requests.some((request) => request.url === "/after-partial-slow"));
  assert.equal(await (await real).text(), "ok");
  assert.equal(await preparation, false);
  assert.equal(local.requests.filter((request) => request.method === "OPTIONS").length, 2);
  assert.equal(local.requests.filter((request) => request.method === "POST").length, 1);
  await waitUntil(() => local.sockets.size <= 2);
});

test("failure of one probe does not abandon the other in-flight probe", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const local = await localServer(t, { probeBehavior: (index) => index === 1 ? { failProbe: true } : { probeGate: gate.promise } });
  const transport = createHttpTransport({ foregroundPrepareWaitMs: 25 });
  t.after(() => transport.close());
  let settled = false;
  const preparation = transport.prepare(local.origin).finally(() => { settled = true; });
  await waitUntil(() => local.requests.filter((request) => request.method === "OPTIONS").length === 2);
  await delay(20);
  assert.equal(settled, false);

  const real = transport.fetch(`${local.origin}/after-failed-and-slow`);
  assert.equal(await (await real).text(), "ok");
  assert.equal(await preparation, false);
  assert.equal(local.requests.filter((request) => request.method === "OPTIONS").length, 2);
  await waitUntil(() => local.sockets.size <= 2);
});

test("the shared eight-second deadline cancels both stalled probes and leaves no socket", { timeout: 15_000 }, async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const local = await localServer(t, { probeBehavior: (index) => index === 1
    ? { probeGate: gate.promise } : { probeBodyGate: gate.promise } });
  const transport = createHttpTransport();
  t.after(() => transport.close());

  const started = performance.now();
  await assert.rejects(transport.prepare(local.origin), (error: unknown) => error instanceof Error && error.name === "TimeoutError");
  const elapsed = performance.now() - started;
  assert(elapsed >= 7_500 && elapsed < 12_000, `both probes share one deadline, observed ${elapsed}ms`);
  assert.equal(local.requests.filter((request) => request.method === "OPTIONS").length, 2);
  await waitUntil(() => local.sockets.size === 0);
  assert.equal(await (await transport.fetch(`${local.origin}/after-deadline`)).text(), "ok");
});

test("a failed preparation does not block the real request", async (t) => {
  const gate = deferred();
  const local = await localServer(t, { probeGate: gate.promise, failProbe: true });
  const transport = createHttpTransport();
  t.after(() => transport.close());

  const preparation = transport.prepare(local.origin).catch(() => undefined);
  await waitUntil(() => local.requests.some((request) => request.method === "OPTIONS"));
  const real = transport.fetch(`${local.origin}/after-failed-prepare`);
  gate.resolve();

  assert.equal(await (await real).text(), "ok");
  await preparation;
  assert.equal(local.requests.some((request) => request.url === "/after-failed-prepare"), true);
});

test("foreground requests supersede slow preparation headers or body within a short budget", async (t) => {
  for (const stage of ["headers", "body"] as const) {
    await t.test(stage, async (t) => {
      const gate = deferred();
      t.after(() => gate.resolve());
      const local = await localServer(t, stage === "headers"
        ? { probeGate: gate.promise } : { probeBodyGate: gate.promise });
      const transport = createHttpTransport({ foregroundPrepareWaitMs: 25 });
      t.after(() => transport.close());
      const first = transport.prepare(local.origin);
      const second = transport.prepare(local.origin);
      await waitUntil(() => local.requests.filter((request) => request.method === "OPTIONS").length === 2);

      // The server gate stays closed: dispatch must not depend on the probe
      // finishing or its separate eight-second lifetime expiring.
      const real = transport.fetch(`${local.origin}/foreground`, { method: "POST", body: "translate" });
      await waitUntil(() => local.requests.some((request) => request.url === "/foreground"));
      assert.equal(await (await real).text(), "ok");
      assert.deepEqual(await Promise.all([first, second]), [false, false]);
      assert.equal(local.requests.filter((request) => request.method === "OPTIONS").length, 2);
      assert.equal(local.requests.filter((request) => request.method === "POST").length, 1);
    });
  }
});

test("both superseded probes release capacity for two concurrent foreground POSTs without duplicates", async (t) => {
  const probeGate = deferred();
  const postGate = deferred();
  t.after(() => { probeGate.resolve(); postGate.resolve(); });
  const local = await localServer(t, { probeBodyGate: probeGate.promise, postGate: postGate.promise });
  const transport = createHttpTransport({ foregroundPrepareWaitMs: 25 });
  t.after(() => transport.close());
  const preparation = transport.prepare(local.origin);
  await waitUntil(() => local.requests.filter((request) => request.method === "OPTIONS").length === 2);

  const first = transport.fetch(`${local.origin}/foreground-a`, { method: "POST", body: "a" });
  const second = transport.fetch(`${local.origin}/foreground-b`, { method: "POST", body: "b" });
  await waitUntil(() => local.requests.filter((request) => request.method === "POST").length === 2);
  assert.equal(await preparation, false);
  assert.equal(local.requests.filter((request) => request.method === "OPTIONS").length, 2);
  assert.equal(local.requests.filter((request) => request.url === "/foreground-a").length, 1);
  assert.equal(local.requests.filter((request) => request.url === "/foreground-b").length, 1);
  // Both POSTs are still active. The cancelled probe must not retain a third
  // socket or one of the pool's two usable request slots.
  await waitUntil(() => local.sockets.size === 2);
  postGate.resolve();
  assert.equal(await (await first).text(), "ok");
  assert.equal(await (await second).text(), "ok");
});

test("cancelling a foreground waiter clears its budget without aborting shared preparation", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const local = await localServer(t, { probeGate: gate.promise });
  const transport = createHttpTransport({ foregroundPrepareWaitMs: 25 });
  t.after(() => transport.close());
  let prepared = false;
  const preparation = transport.prepare(local.origin).then((ready) => { prepared = true; return ready; });
  await waitUntil(() => local.requests.filter((request) => request.method === "OPTIONS").length === 2);

  const controller = new AbortController();
  const cancelled = transport.fetch(`${local.origin}/cancelled`, {
    method: "POST", body: "must not send", signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === "AbortError");
  await delay(50);
  assert.equal(prepared, false);
  assert.equal(local.requests.some((request) => request.method === "POST"), false);
  assert.equal(local.sockets.size, 2);

  gate.resolve();
  assert.equal(await preparation, true);
  assert.equal(await (await transport.fetch(`${local.origin}/after-cancel`, { method: "POST" })).text(), "ok");
  assert.equal(local.connectionCount(), 2);
});

test("aborting one preparation waiter does not cancel the shared warm-up", async (t) => {
  const gate = deferred();
  const local = await localServer(t, { probeGate: gate.promise });
  const transport = createHttpTransport();
  t.after(() => transport.close());
  const controller = new AbortController();

  const cancelled = transport.prepare(local.origin, controller.signal);
  const remaining = transport.prepare(local.origin);
  await waitUntil(() => local.requests.filter((request) => request.method === "OPTIONS").length === 2);
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(local.requests.filter((request) => request.method === "OPTIONS").length, 2);

  gate.resolve();
  await remaining;
  assert.equal(local.connectionCount(), 2);
});

test("prepare skips an active or already connected origin", async (t) => {
  const local = await localServer(t);
  const transport = createHttpTransport();
  t.after(() => transport.close());
  const controller = new AbortController();
  const pending = transport.fetch(`${local.origin}/pending`, { signal: controller.signal });
  await waitUntil(() => local.requests.some((request) => request.url === "/pending"));

  assert.equal(await transport.prepare(local.origin), true);
  assert.equal(local.requests.some((request) => request.method === "OPTIONS"), false);
  controller.abort();
  await assert.rejects(pending);

  assert.equal(await (await transport.fetch(`${local.origin}/connected`)).text(), "ok");
  assert.equal(await transport.prepare(local.origin), true);
  assert.equal(local.requests.some((request) => request.method === "OPTIONS"), false);
});

test("prepare does not report ready when the probe connection closes", async (t) => {
  const local = await localServer(t, { closeProbeConnection: true });
  const transport = createHttpTransport();
  t.after(() => transport.close());

  assert.equal(await transport.prepare(local.origin), false);
  assert.equal(local.requests.filter((request) => request.method === "OPTIONS").length, 2);
  assert.equal(local.sockets.size, 0);
});

test("prepare does not race an ordinary fetch that has not connected yet", async (t) => {
  const local = await localServer(t);
  const transport = createHttpTransport();
  t.after(() => transport.close());
  const controller = new AbortController();

  const request = transport.fetch(`${local.origin}/pending`, { signal: controller.signal });
  assert.equal(await transport.prepare(local.origin), false);
  assert.equal(local.requests.some((entry) => entry.method === "OPTIONS"), false);

  controller.abort();
  await assert.rejects(request);
});

test("after all idle connections close, preparation warms both concurrent HTTP/1 POSTs", async (t) => {
  const postGate = deferred();
  const local = await localServer(t, { postGate: postGate.promise });
  const transport = createHttpTransport();
  t.after(() => transport.close());

  assert.equal(await (await transport.fetch(`${local.origin}/connection-test`)).text(), "ok");
  local.server.closeIdleConnections();
  await waitUntil(() => local.sockets.size === 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(await transport.prepare(local.origin), true);
  const probes = local.requests.filter((entry) => entry.method === "OPTIONS");
  assert.equal(probes.length, 2);
  const preparedConnectionIds = new Set(probes.map((entry) => entry.connectionId));
  assert.equal(preparedConnectionIds.size, 2);
  const connectionsAfterPrepare = local.connectionCount();
  const first = transport.fetch(`${local.origin}/translate-a`, { method: "POST", body: "a" });
  const second = transport.fetch(`${local.origin}/translate-b`, { method: "POST", body: "b" });
  await waitUntil(() => local.requests.filter((entry) => entry.method === "POST").length === 2);

  const posts = local.requests.filter((entry) => entry.method === "POST");
  assert.deepEqual(new Set(posts.map((entry) => entry.connectionId)), preparedConnectionIds);
  assert.equal(local.connectionCount(), connectionsAfterPrepare);
  postGate.resolve();
  assert.equal(await (await first).text(), "ok");
  assert.equal(await (await second).text(), "ok");
});

test("close aborts both in-flight probes and releases their sockets", async (t) => {
  const gate = deferred();
  const local = await localServer(t, { probeGate: gate.promise });
  const transport = createHttpTransport();
  t.after(() => transport.close());

  const preparation = transport.prepare(local.origin);
  await waitUntil(() => local.requests.filter((request) => request.method === "OPTIONS").length === 2);
  await transport.close();
  await assert.rejects(preparation);
  gate.resolve();
  for (let attempt = 0; attempt < 20 && local.sockets.size; attempt++) await delay(10);
  assert.equal(local.sockets.size, 0);
});

test("close aborts active work, destroys sockets, and is safe to await", async (t) => {
  const local = await localServer(t);
  const transport = createHttpTransport();
  t.after(() => transport.close());
  assert.equal(await (await transport.fetch(`${local.origin}/open`)).text(), "ok");
  assert.equal(local.sockets.size, 1);

  const pendingRequest = new Promise<void>((resolve) => local.server.once("request", () => resolve()));
  const pending = transport.fetch(`${local.origin}/pending`);
  await pendingRequest;
  const closing = transport.close();
  await assert.rejects(pending);
  await closing;
  for (let attempt = 0; attempt < 20 && local.sockets.size; attempt++) await delay(10);
  assert.equal(local.sockets.size, 0);
  await assert.rejects(transport.fetch(`${local.origin}/closed`));
});
