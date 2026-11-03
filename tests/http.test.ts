import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { createHttpTransport } from "../src/host/http.js";
import { ModelProviders } from "../src/host/providers.js";
import { resolveProxySettings } from "../src/host/proxy.js";

const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

function environment(t: TestContext, values: Record<string, string>): void {
  const saved = new Map(proxyKeys.map((key) => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function listen(t: TestContext, server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function fixture(t: TestContext, slowPrepare = false) {
  const requests: string[] = [];
  const tunnels: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/redirect") {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/destination` }).end();
      return;
    }
    if (request.url === "/destination") { response.end("direct destination"); return; }
    if (request.method === "OPTIONS") {
      if (!slowPrepare) response.writeHead(204).end();
      return;
    }
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [{ slug: "fixture-model", visibility: "list" }] }));
  });
  const port = await listen(t, server);
  const proxy = createServer();
  proxy.on("connect", (request, client, head) => {
    tunnels.push(request.url ?? "");
    const upstream = connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  const proxyPort = await listen(t, proxy);
  return { port, proxyUrl: `http://127.0.0.1:${proxyPort}`, requests, tunnels };
}

for (const key of ["http_proxy", "HTTP_PROXY"]) {
  test(`signed-in model discovery uses ${key} instead of resolving the target directly`, async (t) => {
    const setup = await fixture(t);
    environment(t, { [key]: setup.proxyUrl });
    const http = createHttpTransport();
    t.after(() => http.close());
    const models = await new ModelProviders(
      { accessToken: async () => "fixture-token" }, http.fetch, "http://folio-models.invalid/v1",
    ).listModels(AbortSignal.timeout(2_000));
    assert.deepEqual(models.map((model) => model.id), ["fixture-model"]);
    assert.deepEqual(setup.requests, ["GET /v1/models"]);
    assert.deepEqual(setup.tunnels, ["folio-models.invalid:80"]);
  });
}

test("NO_PROXY keeps local model endpoints direct", async (t) => {
  const setup = await fixture(t);
  environment(t, { HTTP_PROXY: setup.proxyUrl, NO_PROXY: "127.0.0.1" });
  const http = createHttpTransport();
  t.after(() => http.close());
  const models = await new ModelProviders(
    { accessToken: async () => "fixture-token" }, http.fetch, `http://127.0.0.1:${setup.port}/v1`,
  ).listModels(AbortSignal.timeout(2_000));
  assert.equal(models.length, 1);
  assert.deepEqual(setup.tunnels, []);
});

test("a GUI host with no proxy environment uses the macOS system proxy", async (t) => {
  const setup = await fixture(t);
  environment(t, {});
  const proxyPort = new URL(setup.proxyUrl).port;
  const proxy = resolveProxySettings({ env: {}, platform: "darwin", readSystemProxy: () => `
    HTTPEnable : 1
    HTTPProxy : 127.0.0.1
    HTTPPort : ${proxyPort}
  ` });
  const http = createHttpTransport({ proxy });
  t.after(() => http.close());
  const models = await new ModelProviders(
    { accessToken: async () => "fixture-token" }, http.fetch, "http://folio-models.invalid/v1",
  ).listModels(AbortSignal.timeout(2_000));
  assert.equal(models.length, 1);
  assert.deepEqual(setup.tunnels, ["folio-models.invalid:80"]);
});

test("macOS subnet exclusions bypass the proxy for local model endpoints", async (t) => {
  const setup = await fixture(t);
  environment(t, {});
  const proxy = resolveProxySettings({ env: {}, platform: "darwin", readSystemProxy: () => `
    HTTPEnable : 1
    HTTPProxy : 127.0.0.1
    HTTPPort : ${new URL(setup.proxyUrl).port}
    ExceptionsList : <array> {
      0 : 127.0.0.0/8
    }
  ` });
  const http = createHttpTransport({ proxy });
  t.after(() => http.close());
  const models = await new ModelProviders(
    { accessToken: async () => "fixture-token" }, http.fetch, `http://127.0.0.1:${setup.port}/v1`,
  ).listModels(AbortSignal.timeout(2_000));
  assert.equal(models.length, 1);
  assert.deepEqual(setup.tunnels, []);
});

test("macOS bypass rules are reevaluated after an HTTP redirect", async (t) => {
  const setup = await fixture(t);
  environment(t, {});
  const proxy = resolveProxySettings({ env: {}, platform: "darwin", readSystemProxy: () => `
    HTTPEnable : 1
    HTTPProxy : 127.0.0.1
    HTTPPort : ${new URL(setup.proxyUrl).port}
    ExceptionsList : <array> {
      0 : 127.0.0.1
    }
  ` });
  const http = createHttpTransport({ proxy });
  t.after(() => http.close());
  const response = await http.fetch("http://folio-models.invalid/redirect", { signal: AbortSignal.timeout(2_000) });
  assert.equal(await response.text(), "direct destination");
  assert.deepEqual(setup.tunnels, ["folio-models.invalid:80"]);
});

test("proxied preparation tracks reusable origin connections", async (t) => {
  const setup = await fixture(t);
  environment(t, { HTTP_PROXY: setup.proxyUrl });
  const http = createHttpTransport();
  t.after(() => http.close());
  const signal = AbortSignal.timeout(2_000);
  assert.equal(await http.prepare("http://folio-models.invalid", signal), true);
  assert.equal(await http.prepare("http://folio-models.invalid", signal), true);
  assert.equal(setup.requests.length, 2, "second prepare must reuse the warm pool");
});

test("foreground model discovery supersedes a stalled proxied preparation", async (t) => {
  const setup = await fixture(t, true);
  environment(t, { HTTP_PROXY: setup.proxyUrl });
  const http = createHttpTransport({ foregroundPrepareWaitMs: 10 });
  t.after(() => http.close());
  const preparation = http.prepare("http://folio-models.invalid");
  // Attach immediately so a broken transport is also reported by the test.
  const prepared = preparation.then((value) => value, () => false);
  const models = await new ModelProviders(
    { accessToken: async () => "fixture-token" }, http.fetch, "http://folio-models.invalid/v1",
  ).listModels(AbortSignal.timeout(2_000));
  assert.equal(models.length, 1);
  assert.equal(await prepared, false);
});
