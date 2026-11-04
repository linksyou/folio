import assert from "node:assert/strict";
import { test } from "node:test";
import { HostService } from "../src/host/service.js";
import type { ChatGPTAuth } from "../src/host/auth/index.js";
import type { ModelProviders } from "../src/host/providers.js";
import type { Settings, SettingsStore } from "../src/host/settings.js";
import type { AuthStatus, HostCommand, SaveSettings, TextBlock, Translation } from "../src/shared/protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const state = {
    settings: {
      provider: "custom", chatgptModel: "", customBaseUrl: "https://model.test.invalid/v1",
      customModel: "test-model", targetLanguage: "zh-CN", apiKey: "test-key", revision: "initial",
    } as Settings,
    auth: { state: "signed_out", profiles: [], planEnabled: false } as AuthStatus,
  };
  const settings = {
    read: async () => ({ ...state.settings }),
    save: async (input: SaveSettings) => {
      state.settings = { ...state.settings, ...input, revision: `${state.settings.revision}.saved` };
      return { ...state.settings };
    },
  } as SettingsStore;
  const auth = {
    status: async () => structuredClone(state.auth),
    selectProfile: async (id: string) => {
      state.auth = { state: "signed_in", profiles: [{ id, label: id }], profile: { id, label: id }, planEnabled: true };
      return structuredClone(state.auth);
    },
    signOut: async () => {
      state.auth = { state: "signed_out", profiles: [], planEnabled: false };
      return { revoked: true };
    },
    cancelSignIn: () => {},
  } as unknown as ChatGPTAuth;
  const providers = {
    translate: async (_settings: Settings, blocks: TextBlock[], _signal: AbortSignal, onProgress?: (translations: Translation[]) => void) => {
      const result = blocks.map((block) => ({ id: block.id, text: `translated ${block.text}` }));
      onProgress?.(result);
      return result;
    },
  } as unknown as ModelProviders;
  const service = new HostService(settings, auth, providers);
  return { state, settings, auth, providers, service };
}

function command(settingsRevision: string, jobId = "job"): Extract<HostCommand, { type: "translate" }> {
  return { type: "translate", settingsRevision, jobId, batchId: "batch", blocks: [{ id: "p1", text: "source paragraph" }] };
}

test("translation validates two preflight snapshots and retains the final freshness check", async (t) => {
  const f = fixture();
  const revision = (await f.service.status()).settingsRevision;
  const settingsRead = t.mock.method(f.settings, "read");
  const authRead = t.mock.method(f.auth, "status");
  const translate = t.mock.method(f.providers, "translate");
  const progress: Translation[][] = [];
  assert.deepEqual(await f.service.handle(command(revision), (value) => progress.push(value)), [{ id: "p1", text: "translated source paragraph" }]);
  assert.equal(settingsRead.mock.callCount(), 3);
  assert.equal(authRead.mock.callCount(), 3);
  assert.equal(translate.mock.callCount(), 1);
  assert.equal(progress.length, 1);
  const preflightSettings = await settingsRead.mock.calls[1].result;
  assert.equal(translate.mock.calls[0].arguments[0], preflightSettings, "provider receives the exact settings snapshot used for validation");
});

test("a settings save racing a status read causes a fresh snapshot", async (t) => {
  const f = fixture();
  const previous = await f.service.status();
  const readEntered = deferred<void>();
  const finishRead = deferred<Settings>();
  const oldSettings = { ...f.state.settings };
  let calls = 0;
  t.mock.method(f.settings, "read", async () => {
    calls++;
    if (calls === 1) { readEntered.resolve(); return finishRead.promise; }
    return { ...f.state.settings };
  });
  const pending = f.service.status();
  await readEntered.promise;
  const saved = await f.service.handle({ type: "settings.save", settings: { ...f.state.settings, customModel: "next-model" } });
  finishRead.resolve(oldSettings);
  const latest = await pending;
  assert.deepEqual(latest, saved);
  assert.notEqual(latest.settingsRevision, previous.settingsRevision);
  assert.equal(latest.settings.customModel, "next-model");
  assert.equal(calls, 3, "racing read, save's previous read, then retried status read");
});

test("an external config change during provider work rejects the late result", async (t) => {
  const f = fixture();
  const revision = (await f.service.status()).settingsRevision;
  const entered = deferred<void>();
  const finish = deferred<Translation[]>();
  t.mock.method(f.providers, "translate", async () => { entered.resolve(); return finish.promise; });
  const rejected = assert.rejects(f.service.handle(command(revision)), { code: "CONFIG_REQUIRED" });
  await entered.promise;
  f.state.settings = { ...f.state.settings, revision: "external-write", customModel: "other-model" };
  finish.resolve([{ id: "p1", text: "late result" }]);
  await rejected;
});

test("an external account switch during provider work rejects the late result", async (t) => {
  const f = fixture();
  const revision = (await f.service.status()).settingsRevision;
  t.mock.method(f.providers, "translate", async () => {
    f.state.auth = { state: "signed_in", profile: { id: "other", label: "other" }, profiles: [{ id: "other", label: "other" }], planEnabled: true };
    return [{ id: "p1", text: "late result" }];
  });
  await assert.rejects(f.service.handle(command(revision)), { code: "CONFIG_REQUIRED" });
});

for (const operation of ["save", "select", "logout"] as const) {
  test(`${operation} cancels ongoing translations and suppresses late progress`, async (t) => {
    const f = fixture();
    const revision = (await f.service.status()).settingsRevision;
    const entered = deferred<void>();
    const finish = deferred<void>();
    const progress: Translation[][] = [];
    t.mock.method(f.providers, "translate", async (_settings: Settings, _blocks: TextBlock[], _signal: AbortSignal, onProgress?: (translations: Translation[]) => void) => {
      entered.resolve(); await finish.promise;
      const result = [{ id: "p1", text: "late result" }];
      onProgress?.(result);
      return result;
    });
    const rejected = assert.rejects(f.service.handle(command(revision), (value) => progress.push(value)), (error: unknown) =>
      error instanceof Error && (("code" in error && error.code === "CANCELLED") || error.name === "AbortError"));
    await entered.promise;
    if (operation === "save") await f.service.handle({ type: "settings.save", settings: { ...f.state.settings, customModel: "next" } });
    else if (operation === "select") await f.service.handle({ type: "auth.select", profileId: "next" });
    else await f.service.handle({ type: "auth.logout" });
    finish.resolve();
    await rejected;
    assert.deepEqual(progress, []);
    assert.equal(f.service.isTranslationActive("job", "batch"), false);
  });
}

test("cancelling one concurrent batch does not cancel another batch", async (t) => {
  const f = fixture();
  const revision = (await f.service.status()).settingsRevision;
  const bothEntered = deferred<void>();
  const finish = deferred<void>();
  let entered = 0;
  t.mock.method(f.providers, "translate", async (_settings: Settings, blocks: TextBlock[], _signal: AbortSignal, onProgress?: (translations: Translation[]) => void) => {
    if (++entered === 2) bothEntered.resolve();
    await finish.promise;
    const result = blocks.map((block) => ({ id: block.id, text: "translated" }));
    onProgress?.(result); return result;
  });
  const firstProgress: Translation[][] = [];
  const secondProgress: Translation[][] = [];
  const first = assert.rejects(f.service.handle(command(revision, "first"), (value) => firstProgress.push(value)), (error: unknown) =>
    error instanceof Error && (("code" in error && error.code === "CANCELLED") || error.name === "AbortError"));
  const second = f.service.handle(command(revision, "second"), (value) => secondProgress.push(value));
  await bothEntered.promise;
  await f.service.handle({ type: "translate.cancelBatch", jobId: "first", batchId: "batch" });
  finish.resolve();
  await first;
  assert.deepEqual(await second, [{ id: "p1", text: "translated" }]);
  assert.deepEqual(firstProgress, []);
  assert.equal(secondProgress.length, 1);
});

for (const slowRead of ["auth", "settings"] as const) {
  test(`external changes during a slow ${slowRead} preflight read are rejected before provider dispatch`, async (t) => {
    const f = fixture();
    const revision = (await f.service.status()).settingsRevision;
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalSettings = { ...f.state.settings };
    const originalAuth = structuredClone(f.state.auth);
    let slowCalls = 0;
    if (slowRead === "auth") {
      t.mock.method(f.auth, "status", async () => {
        if (++slowCalls === 1) { entered.resolve(); await release.promise; return originalAuth; }
        return structuredClone(f.state.auth);
      });
    } else {
      t.mock.method(f.settings, "read", async () => {
        if (++slowCalls === 1) { entered.resolve(); await release.promise; return originalSettings; }
        return { ...f.state.settings };
      });
    }
    const translate = t.mock.method(f.providers, "translate");
    const progress: Translation[][] = [];
    const rejected = assert.rejects(f.service.handle(command(revision), (value) => progress.push(value)), { code: "CONFIG_REQUIRED" });
    await entered.promise;
    // Bypass service.handle to represent a different Host process writing files.
    if (slowRead === "auth") f.state.settings = { ...f.state.settings, revision: "external-write", customModel: "next-model" };
    else f.state.auth = { state: "signed_in", profile: { id: "other", label: "other" }, profiles: [{ id: "other", label: "other" }], planEnabled: true };
    release.resolve();
    await rejected;
    assert.equal(translate.mock.callCount(), 0, "stale credentials/configuration must never dispatch a model request");
    assert.deepEqual(progress, []);
  });
}
