import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import lockfile from "proper-lockfile";
import { ChatGPTAuth } from "../src/host/auth/index.js";
import { SHARING_SCOPE } from "../src/host/auth/oauth.js";
import { AuthStore } from "../src/host/auth/store.js";
import type { StoredProfile } from "../src/host/auth/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "folio-auth-status-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function profile(id: string, expiresAt = Date.now() + 3_600_000): StoredProfile {
  return {
    id, label: id, clientId: `client_${id}`, savedAt: new Date().toISOString(),
    state: "signed_in", scopes: [SHARING_SCOPE],
    credentials: { accessToken: `test_access_${id}`, refreshToken: `test_refresh_${id}`, expiresAt },
  };
}

async function seed(store: AuthStore, profiles: StoredProfile[]): Promise<void> {
  await store.withLock(async (state) => {
    state.profiles = profiles;
    state.activeProfileId = profiles[0]?.id;
    await store.writeLocked(state);
  });
}

test("six concurrent status readers share one file-lock attempt across auth instances", async (t) => {
  const dataDir = await directory(t);
  const lock = t.mock.method(lockfile, "lock");
  const started = performance.now();
  const completed: number[] = [];
  const statuses = await Promise.all(Array.from({ length: 6 }, async () => {
    const value = await new ChatGPTAuth({ dataDir }).status();
    completed.push(performance.now() - started);
    return value;
  }));
  assert.equal(lock.mock.callCount(), 1, "overlapping reads must not incur ELOCKED retries");
  assert.ok(statuses.every((status) => status.state === "signed_out"));
  t.diagnostic(`six readers completed at ${completed.map((ms) => ms.toFixed(2)).join(", ")} ms`);
});

test("in-process writers queue without polling and do not lose updates", async (t) => {
  const dataDir = await directory(t);
  const lock = t.mock.method(lockfile, "lock");
  await Promise.all(Array.from({ length: 6 }, (_, index) => {
    const store = new AuthStore(dataDir);
    return store.withLock(async (state) => {
      state.profiles.push(profile(String(index)));
      await store.writeLocked(state);
    });
  }));
  assert.equal(lock.mock.callCount(), 6, "one acquisition per writer, without 100 ms collision retries");
  assert.deepEqual((await new AuthStore(dataDir).read()).profiles.map((entry) => entry.id), ["0", "1", "2", "3", "4", "5"]);
});

test("a queued write separates read flights and readers receive independent snapshots", async (t) => {
  const store = new AuthStore(await directory(t));
  await seed(store, [profile("old")]);
  const before = store.read();
  const save = seed(store, [profile("new")]);
  const after = store.read();
  const [oldState, newState] = await Promise.all([before, after]);
  await save;
  assert.equal(oldState.activeProfileId, "old");
  assert.equal(newState.activeProfileId, "new");
  const [first, second] = await Promise.all([store.read(), store.read()]);
  first.profiles[0].label = "mutated by reader";
  assert.equal(second.profiles[0].label, "new");
  await seed(store, [profile("latest")]);
  assert.equal((await store.read()).activeProfileId, "latest", "completed reads are never retained as a TTL cache");
});

test("a failed status read is not retained and a later read can recover", async (t) => {
  const dataDir = await directory(t);
  const realLock = lockfile.lock;
  let fail = true;
  t.mock.method(lockfile, "lock", (...args: Parameters<typeof lockfile.lock>) => {
    if (fail) { fail = false; return Promise.reject(new Error("simulated disk failure")); }
    return realLock(...args);
  });
  const auth = new ChatGPTAuth({ dataDir });
  await Promise.all([1, 2].map(() => assert.rejects(auth.status(), { code: "STORAGE_ERROR" })));
  assert.equal((await auth.status()).state, "signed_out");
});

test("cancelling a queued operation is prompt and does not let another writer overtake the owner", async (t) => {
  const store = new AuthStore(await directory(t));
  const entered = deferred();
  const release = deferred();
  const order: string[] = [];
  const owner = store.withLock(async () => {
    order.push("owner.start"); entered.resolve(); await release.promise; order.push("owner.end");
  });
  await entered.promise;
  const controller = new AbortController();
  const cancelled = assert.rejects(store.withLock(async () => { order.push("cancelled"); }, controller.signal), { code: "CANCELLED" });
  controller.abort();
  await cancelled;
  const later = store.withLock(async () => { order.push("later"); });
  await nextTurn();
  assert.deepEqual(order, ["owner.start"]);
  release.resolve();
  await Promise.all([owner, later]);
  assert.deepEqual(order, ["owner.start", "owner.end", "later"]);
});

for (const change of ["cancel", "select"] as const) {
  test(`refresh-token rotation finishes its save before ${change} discards the request`, async (t) => {
    const dataDir = await directory(t);
    const store = new AuthStore(dataDir);
    await seed(store, [profile("first", Date.now() - 1), profile("second")]);
    const requested = deferred();
    const respond = deferred();
    let refreshCalls = 0;
    const auth = new ChatGPTAuth({
      dataDir,
      endpoints: {
        issuer: "https://auth.test.invalid", authorization: "https://auth.test.invalid/authorize",
        token: "https://auth.test.invalid/token", jwks: "https://auth.test.invalid/jwks",
      },
      fetch: async (url, options) => {
        assert.equal(String(url), "https://auth.test.invalid/token");
        assert.equal(new URLSearchParams(options?.body as URLSearchParams).get("refresh_token"), "test_refresh_first");
        refreshCalls++; requested.resolve(); await respond.promise;
        return Response.json({ access_token: "test_access_rotated", refresh_token: "test_refresh_rotated", token_type: "Bearer", expires_in: 3600 });
      },
    });
    const controller = new AbortController();
    let settled = false;
    const token = auth.accessToken(controller.signal);
    void token.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(token, { code: "CANCELLED" });
    await requested.promise;
    const switched = change === "select" ? auth.selectProfile("second") : undefined;
    if (change === "cancel") controller.abort();
    await nextTurn();
    assert.equal(settled, false, "Host must keep waiting until rotated credentials are durable");
    respond.resolve();
    await rejected;
    await switched;
    const saved = await store.read();
    assert.equal(saved.profiles[0].credentials?.refreshToken, "test_refresh_rotated");
    assert.equal(saved.activeProfileId, change === "select" ? "second" : "first");
    assert.equal(refreshCalls, 1);
    assert.equal(await auth.accessToken(), change === "select" ? "test_access_second" : "test_access_rotated");
  });
}

test("status retains the cross-process lock and observes another process's completed write", { timeout: 10_000 }, async (t) => {
  const dataDir = await directory(t);
  const store = new AuthStore(dataDir);
  await seed(store, [profile("before")]);
  const script = `
    import { AuthStore } from ${JSON.stringify(new URL("../src/host/auth/store.ts", import.meta.url).href)};
    const store = new AuthStore(process.argv[1]);
    await store.withLock(async state => {
      process.stdout.write('locked\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      state.profiles[0].label = 'written in child';
      await store.writeLocked(state);
    });
    process.stdin.destroy();
  `;
  const child = spawn(process.execPath, ["--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href, "--input-type=module", "--eval", script, dataDir], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += String(data); });
  const exited = once(child, "exit");
  assert.match(String((await once(child.stdout, "data"))[0]), /locked/);
  const blocked = deferred();
  const realLock = lockfile.lock;
  t.mock.method(lockfile, "lock", async (...args: Parameters<typeof lockfile.lock>) => {
    try { return await realLock(...args); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ELOCKED") blocked.resolve();
      throw error;
    }
  });
  let resolved = false;
  const status = new ChatGPTAuth({ dataDir }).status().then((value) => { resolved = true; return value; });
  await blocked.promise;
  assert.equal(resolved, false);
  child.stdin.end("release");
  assert.equal((await status).profile?.label, "written in child");
  assert.equal((await exited)[0], 0, stderr);
  assert.equal((await store.read()).profiles[0].label, "written in child");
});
