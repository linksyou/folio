import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError } from "../src/shared/errors.js";
import { EXTENSION_ID } from "../src/shared/extension-identity.js";
import type { AuthStatus, HostCommand, SaveSettings, Translation } from "../src/shared/protocol.js";
import type { ChatGPTAuth } from "../src/host/auth/index.js";
import { encodeMessage, MessageDecoder } from "../src/host/framing.js";
import type { ModelProviders } from "../src/host/providers.js";
import { HostService } from "../src/host/service.js";
import { sameGenerationSettings, type Settings, type SettingsStore } from "../src/host/settings.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function expectCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    return true;
  };
}

class FakeSettings {
  value: Settings = {
    provider: "custom",
    chatgptModel: "",
    customBaseUrl: "https://custom.test/v1",
    customModel: "test-model",
    apiKey: "secret",
    revision: "settings-1",
  };

  async read(): Promise<Settings> { return { ...this.value }; }

  async save(input: SaveSettings): Promise<Settings> {
    const next: Settings = {
      ...this.value,
      ...input,
      provider: input.provider,
      chatgptModel: input.chatgptModel.trim(),
      customBaseUrl: input.customBaseUrl.trim(),
      customModel: input.customModel.trim(),
      apiKey: input.apiKey === undefined ? this.value.apiKey : input.apiKey.trim(),
      revision: this.value.revision,
    };
    if (!sameGenerationSettings(this.value, next)) next.revision = `settings-${Number(this.value.revision.split("-")[1]) + 1}`;
    this.value = next;
    return { ...this.value };
  }
}

class FakeAuth {
  value: AuthStatus = {
    state: "signed_in",
    profile: { id: "profile-1", label: "Reader" },
    profiles: [{ id: "profile-1", label: "Reader" }],
    planEnabled: true,
  };

  async status(): Promise<AuthStatus> { return structuredClone(this.value); }
  cancelSignIn(): void {}
  async signIn(): Promise<AuthStatus> { return this.status(); }
  async signOut(): Promise<{ revoked: boolean }> {
    this.value = { state: "signed_out", profiles: this.value.profiles, planEnabled: false };
    return { revoked: true };
  }
  async selectProfile(id: string): Promise<AuthStatus> {
    this.value = {
      ...this.value,
      profile: { id, label: id },
      profiles: [...this.value.profiles, { id, label: id }],
    };
    return this.status();
  }
}

function serviceWith(
  settings: FakeSettings,
  auth: FakeAuth,
  providers: Partial<ModelProviders>,
): HostService {
  return new HostService(
    settings as unknown as SettingsStore,
    auth as unknown as ChatGPTAuth,
    providers as ModelProviders,
  );
}

test("preparation does not authenticate or generate text and failure is best effort", async () => {
  const settings = new FakeSettings();
  const auth = new FakeAuth();
  auth.status = async () => { throw new Error("preparation must not read authentication"); };
  let calls = 0;
  const service = serviceWith(settings, auth, {
    async prepare(current) {
      assert.equal(current.customBaseUrl, settings.value.customBaseUrl);
      if (++calls === 2) throw new Error("gateway rejects preparation");
      return true;
    },
    async translate() { throw new Error("preparation must not generate text"); },
  });
  assert.deepEqual(await service.handle({ type: "connection.prepare" }), { ready: true });
  assert.deepEqual(await service.handle({ type: "connection.prepare" }), { ready: false });
});

test("closing the host aborts a pending connection preparation", async () => {
  const started = deferred();
  const service = serviceWith(new FakeSettings(), new FakeAuth(), {
    prepare(_settings, signal) {
      started.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const pending = service.handle({ type: "connection.prepare" });
  await started.promise;
  service.close();
  assert.deepEqual(await pending, { ready: false });
});

test("translation uses a coherent settings snapshot and rejects a stale settings revision", async () => {
  const settings = new FakeSettings();
  const auth = new FakeAuth();
  const seen: Settings[] = [];
  const service = serviceWith(settings, auth, {
    async translate(current): Promise<Translation[]> {
      seen.push({ ...current });
      return [{ id: "block", text: "译文" }];
    },
  });
  const initial = await service.status();
  const command: HostCommand = {
    type: "translate",
    jobId: "job-current",
    settingsRevision: initial.settingsRevision,
    blocks: [{ id: "block", text: "Text" }],
  };

  assert.deepEqual(await service.handle(command), [{ id: "block", text: "译文" }]);
  assert.equal(seen[0]?.revision, "settings-1");
  settings.value = { ...settings.value, customModel: "changed-model", revision: "settings-2" };
  await assert.rejects(
    service.handle({ ...command, jobId: "job-stale" }),
    expectCode("CONFIG_REQUIRED"),
  );
  assert.equal(seen.length, 1, "stale work must be rejected before reaching the provider");
});

test("saving settings or selecting an account cancels in-flight translation and changes the revision", async (t) => {
  for (const change of ["settings", "account"] as const) {
    await t.test(change, async () => {
      const settings = new FakeSettings();
      const auth = new FakeAuth();
      const started = deferred();
      let observedAbort = false;
      const service = serviceWith(settings, auth, {
        translate(_settings, _blocks, signal): Promise<Translation[]> {
          started.resolve();
          return new Promise((_, reject) => signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(new AppError("CANCELLED", "翻译已停止。"));
          }, { once: true }));
        },
      });
      const before = await service.status();
      const translation = service.handle({
        type: "translate",
        jobId: `job-${change}`,
        settingsRevision: before.settingsRevision,
        blocks: [{ id: "block", text: "Text" }],
      });
      await started.promise;

      const after = change === "settings"
        ? await service.handle({ type: "settings.save", settings: {
          provider: "custom", chatgptModel: "", customBaseUrl: "https://new.test/v1", customModel: "new-model",
        } }) as Awaited<ReturnType<HostService["status"]>>
        : await service.handle({ type: "auth.select", profileId: "profile-2" }) as Awaited<ReturnType<HostService["status"]>>;

      await assert.rejects(translation, expectCode("CANCELLED"));
      assert.equal(observedAbort, true);
      assert.notEqual(after.settingsRevision, before.settingsRevision);
    });
  }
});

test("service close aborts model listing and connection tests so host shutdown cannot wait for network timeouts", async (t) => {
  for (const command of [{ type: "models.list" }, { type: "connection.test" }] as const) {
    await t.test(command.type, async () => {
      const settings = new FakeSettings();
      const auth = new FakeAuth();
      const started = deferred();
      const waitForAbort = (signal?: AbortSignal): Promise<never> => {
        started.resolve();
        return new Promise((_, reject) => signal?.addEventListener("abort", () => {
          reject(new AppError("CANCELLED", "操作已停止。"));
        }, { once: true }));
      };
      const service = serviceWith(settings, auth, {
        listModels: waitForAbort,
        translate: (_settings, _blocks, signal) => waitForAbort(signal),
      });
      const request = service.handle(command);
      await started.promise;
      service.close();
      await assert.rejects(request, expectCode("CANCELLED"));
    });
  }
});

test("cancelling one batch leaves another batch in the same job running", async () => {
  const settings = new FakeSettings();
  const auth = new FakeAuth();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const service = serviceWith(settings, auth, {
    translate(_settings, blocks, signal): Promise<Translation[]> {
      if (blocks[0]?.id === "first") {
        firstStarted.resolve();
        return new Promise((_, reject) => signal.addEventListener("abort", () =>
          reject(new AppError("CANCELLED", "批次已取消。")), { once: true }));
      }
      secondStarted.resolve();
      return Promise.resolve([{ id: "second", text: "第二批" }]);
    },
  });
  const revision = (await service.status()).settingsRevision;
  const first = service.handle({
    type: "translate", jobId: "shared-job", batchId: "batch-first", settingsRevision: revision,
    blocks: [{ id: "first", text: "First" }],
  });
  const second = service.handle({
    type: "translate", jobId: "shared-job", batchId: "batch-second", settingsRevision: revision,
    blocks: [{ id: "second", text: "Second" }],
  });
  await Promise.all([firstStarted.promise, secondStarted.promise]);

  await service.handle({ type: "translate.cancelBatch", jobId: "shared-job", batchId: "batch-first" });
  await assert.rejects(first, expectCode("CANCELLED"));
  assert.deepEqual(await second, [{ id: "second", text: "第二批" }]);
});

test("a queued batch is removed without reaching the provider", async () => {
  const settings = new FakeSettings();
  const auth = new FakeAuth();
  const started = [deferred(), deferred()];
  const release = deferred();
  const providerBlocks: string[] = [];
  const service = serviceWith(settings, auth, {
    async translate(_settings, blocks): Promise<Translation[]> {
      const id = blocks[0]!.id;
      providerBlocks.push(id);
      if (id === "one") started[0].resolve();
      if (id === "two") started[1].resolve();
      await release.promise;
      return [{ id, text: `译文 ${id}` }];
    },
  });
  const revision = (await service.status()).settingsRevision;
  const command = (id: string): HostCommand => ({
    type: "translate", jobId: "queued-job", batchId: id, settingsRevision: revision,
    blocks: [{ id, text: id }],
  });
  const one = service.handle(command("one"));
  const two = service.handle(command("two"));
  await Promise.all(started.map((entry) => entry.promise));
  const queued = service.handle(command("queued"));

  await service.handle({ type: "translate.cancelBatch", jobId: "queued-job", batchId: "queued" });
  await assert.rejects(queued, expectCode("CANCELLED"));
  assert.deepEqual(providerBlocks.sort(), ["one", "two"]);
  release.resolve();
  await Promise.all([one, two]);
});

test("a batch cancelled before its translate command never starts", async () => {
  const settings = new FakeSettings();
  const auth = new FakeAuth();
  let providerCalls = 0;
  const service = serviceWith(settings, auth, {
    async translate(): Promise<Translation[]> {
      providerCalls++;
      return [{ id: "late", text: "不应出现" }];
    },
  });
  const revision = (await service.status()).settingsRevision;
  await service.handle({ type: "translate.cancelBatch", jobId: "pre-job", batchId: "pre-batch" });
  await assert.rejects(service.handle({
    type: "translate", jobId: "pre-job", batchId: "pre-batch", settingsRevision: revision,
    blocks: [{ id: "late", text: "Late" }],
  }), expectCode("CANCELLED"));
  assert.equal(providerCalls, 0);
});

test("progress emitted after batch cancellation is not forwarded", async () => {
  const settings = new FakeSettings();
  const auth = new FakeAuth();
  const started = deferred();
  const release = deferred();
  const progress: Translation[][] = [];
  const service = serviceWith(settings, auth, {
    async translate(_settings, _blocks, _signal, onProgress): Promise<Translation[]> {
      onProgress?.([{ id: "block", text: "部分译文" }]);
      started.resolve();
      await release.promise;
      onProgress?.([{ id: "block", text: "取消后的迟到译文" }]);
      return [{ id: "block", text: "最终译文" }];
    },
  });
  const revision = (await service.status()).settingsRevision;
  const translation = service.handle({
    type: "translate", jobId: "progress-job", batchId: "progress-batch", settingsRevision: revision,
    blocks: [{ id: "block", text: "Text" }],
  }, (translated) => progress.push(translated));
  await started.promise;
  await service.handle({ type: "translate.cancelBatch", jobId: "progress-job", batchId: "progress-batch" });
  release.resolve();

  await assert.rejects(translation, expectCode("CANCELLED"));
  assert.deepEqual(progress, [[{ id: "block", text: "部分译文" }]]);
});

test("native host answers a framed status request and exits after its browser pipe closes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "open-web-translator-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [
    join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    join(process.cwd(), "src", "host", "main.ts"),
    `chrome-extension://${EXTENSION_ID}/`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, OPEN_WEB_TRANSLATOR_DATA_DIR: directory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const decoder = new MessageDecoder();
  const reply = new Promise<unknown>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        const messages = decoder.push(chunk);
        if (messages.length) resolve(messages[0]);
      } catch (error) { reject(error); }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`native host exited before replying: ${code}`));
    });
  });
  child.stdin.write(encodeMessage({ id: "status-1", command: { type: "status" } }));
  const message = await reply as {
    id: string;
    ok: boolean;
    result: { protocolVersion: number; settingsRevision: string; settings: unknown; auth: unknown };
  };
  assert.equal(message.id, "status-1");
  assert.equal(message.ok, true);
  assert.equal(message.result.protocolVersion, 1);
  assert.match(message.result.settingsRevision, /^[0-9a-f]{64}$/);
  assert.deepEqual(message.result.settings, {
    provider: "chatgpt",
    chatgptModel: "",
    chatgptReasoningEffort: "auto",
    customBaseUrl: "https://api.openai.com/v1",
    customModel: "",
    customReasoningEffort: "auto",
    targetLanguage: "zh-CN",
    displayMode: "bilingual",
    hasApiKey: false,
  });
  assert.deepEqual(message.result.auth, { state: "signed_out", profiles: [], planEnabled: false });
  child.stdin.end();
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("native host did not exit after stdin closed")), 3_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0);
});

test("options pages with sender.tab are trusted and simultaneous starts serialize one route per tab", async () => {
  const originalChrome = globalThis.chrome;
  const originalSetTimeout = globalThis.setTimeout;
  const firstInjectionStarted = deferred();
  const releaseFirstInjection = deferred();
  const session = new Map<string, unknown>();
  const pageCommands: Array<{ jobId: string; documentId?: string }> = [];
  const nativeCommands: HostCommand[] = [];
  let onRuntimeMessage: ((message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean) | undefined;
  let injectionCalls = 0;
  let activeInjections = 0;
  let maximumInjections = 0;

  const status = {
    protocolVersion: 1,
    settings: {
      provider: "custom" as const,
      chatgptModel: "",
      customBaseUrl: "https://custom.test/v1",
      customModel: "model",
      hasApiKey: true,
    },
    settingsRevision: "route-revision",
    auth: { state: "signed_out" as const, profiles: [], planEnabled: false },
  };
  const makePort = () => {
    let messageListener: ((message: unknown) => void) | undefined;
    let disconnectListener: (() => void) | undefined;
    return {
      onMessage: { addListener(listener: (message: unknown) => void) { messageListener = listener; } },
      onDisconnect: { addListener(listener: () => void) { disconnectListener = listener; } },
      postMessage(message: { id: string; command: HostCommand }) {
        nativeCommands.push(message.command);
        queueMicrotask(() => messageListener?.({
          id: message.id,
          ok: true,
          result: message.command.type === "status" ? status : {},
        }));
      },
      disconnect() { disconnectListener?.(); },
    };
  };
  const chromeMock = {
    runtime: {
      id: "extension-test-id",
      lastError: undefined,
      getURL: (path: string) => `chrome-extension://extension-test-id/${path}`,
      connectNative: () => makePort(),
      onMessage: { addListener(listener: typeof onRuntimeMessage) { onRuntimeMessage = listener; } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    commands: { onCommand: { addListener() {} } },
    permissions: { onRemoved: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 7, url: "https://article.test/read" }],
      sendMessage: async (_tabId: number, command: { jobId: string }, options?: { documentId?: string }) => {
        pageCommands.push({ jobId: command.jobId, documentId: options?.documentId });
        return { ok: true, result: { status: "running", total: 1, completed: 0, failed: 0, message: "running" } };
      },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    scripting: {
      executeScript: async () => {
        injectionCalls += 1;
        activeInjections += 1;
        maximumInjections = Math.max(maximumInjections, activeInjections);
        const call = injectionCalls;
        if (call === 1) {
          firstInjectionStarted.resolve();
          await releaseFirstInjection.promise;
        }
        activeInjections -= 1;
        return [{ documentId: `document-${call}` }];
      },
    },
    storage: {
      onChanged: { addListener() {} },
      session: {
        async get(key: string) { return { [key]: session.get(key) }; },
        async set(values: Record<string, unknown>) {
          for (const [key, value] of Object.entries(values)) session.set(key, value);
        },
        async remove(key: string) { session.delete(key); },
      },
    },
  };

  Object.defineProperty(globalThis, "chrome", { configurable: true, value: chromeMock });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = originalSetTimeout(...args);
    timers.add(timer);
    return timer;
  }) as typeof setTimeout;
  try {
    await import("../src/extension/background.js");
    assert.ok(onRuntimeMessage);
    const sender = {
      id: chromeMock.runtime.id,
      url: chromeMock.runtime.getURL("options.html"),
      frameId: 0,
      tab: { id: 99 },
    } as chrome.runtime.MessageSender;
    const send = () => new Promise<unknown>((resolve) => {
      assert.equal(onRuntimeMessage?.({ type: "page.action", action: "start" }, sender, resolve), true);
    });

    const first = send();
    await firstInjectionStarted.promise;
    const second = send();
    await Promise.resolve();
    assert.equal(injectionCalls, 1, "the second start waits for the first route transaction");
    releaseFirstInjection.resolve();
    await Promise.all([first, second]);

    assert.equal(injectionCalls, 2);
    assert.equal(maximumInjections, 1);
    assert.equal(pageCommands.length, 2);
    assert.notEqual(pageCommands[0]?.jobId, pageCommands[1]?.jobId);
    assert.deepEqual(pageCommands.map((entry) => entry.documentId), ["document-1", "document-2"]);
    assert.equal(nativeCommands.filter((command) => command.type === "translate.cancel").length, 1);
  } finally {
    // Idle policy is tested in native-client.test.ts. Dispose this mock's
    // timers so they neither extend the test process nor outlive its chrome.
    for (const timer of timers) clearTimeout(timer);
    globalThis.setTimeout = originalSetTimeout;
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
  }
});

test("translation deadline includes queue wait and expires without calling the provider", async () => {
  const settings = new FakeSettings();
  const auth = new FakeAuth();
  let calls = 0;
  const bothStarted = deferred();
  const providers = {
    translate(_settings: Settings, _blocks: unknown, signal: AbortSignal) {
      if (++calls === 2) bothStarted.resolve();
      return new Promise<Translation[]>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  } as unknown as ModelProviders;
  const service = new HostService(settings as unknown as SettingsStore, auth as unknown as ChatGPTAuth, providers, { translationTimeoutMs: 25 });
  const blockers = Promise.allSettled([service.handle({ type: "connection.test" }), service.handle({ type: "connection.test" })]);
  await bothStarted.promise;
  const { settingsRevision } = await service.status();
  await assert.rejects(service.handle({ type: "translate", jobId: "queued", batchId: "b", settingsRevision, blocks: [{ id: "a", text: "private fixture" }] }), expectCode("TIMEOUT"));
  assert.equal(calls, 2, "expired queued translation never reaches provider");
  const diagnostics = JSON.stringify(await service.handle({ type: "diagnostics.get" }));
  assert.match(diagnostics, /queue.enter/);
  assert.match(diagnostics, /timedOut/);
  assert.doesNotMatch(diagnostics, /private fixture|secret|custom.test/);
  service.close();
  await blockers;
});

test("translation deadline aborts active provider and rejects late progress", async () => {
  let aborted = false;
  let progress = 0;
  const service = new HostService(new FakeSettings() as unknown as SettingsStore, new FakeAuth() as unknown as ChatGPTAuth, {
    translate(_settings: Settings, _blocks: unknown, signal: AbortSignal, emit?: (items: Translation[]) => void) {
      return new Promise((resolve) => signal.addEventListener("abort", () => {
        aborted = true;
        emit?.([{ id: "a", text: "late" }]);
        resolve([{ id: "a", text: "late" }]);
      }, { once: true }));
    },
  } as unknown as ModelProviders, { translationTimeoutMs: 25 });
  const { settingsRevision } = await service.status();
  await assert.rejects(service.handle({ type: "translate", jobId: "active", batchId: "b", settingsRevision, blocks: [{ id: "a", text: "source" }] }, () => progress++), expectCode("TIMEOUT"));
  assert.equal(aborted, true);
  assert.equal(progress, 0);
  service.close();
});

test("display-only and unchanged saves preserve an in-flight stream and its revision", async () => {
  const settings = new FakeSettings();
  const started = deferred();
  const finish = deferred();
  const previews: Translation[][] = [];
  let signal!: AbortSignal;
  const service = serviceWith(settings, new FakeAuth(), {
    async translate(_current, blocks, currentSignal, progress) {
      signal = currentSignal;
      progress?.(blocks.map(({ id }) => ({ id, text: "预览" })));
      started.resolve();
      await finish.promise;
      progress?.(blocks.map(({ id }) => ({ id, text: "继续预览" })));
      return blocks.map(({ id }) => ({ id, text: "完成" }));
    },
  });
  const before = await service.status();
  const translation = service.handle({ type: "translate", jobId: "display-save", settingsRevision: before.settingsRevision, blocks: [{ id: "a", text: "A paragraph" }] }, (values) => previews.push(values));
  await started.promise;
  for (const displayMode of ["translation-only", "translation-only", "bilingual"] as const) {
    const after = await service.handle({ type: "settings.save", settings: { ...settings.value, displayMode } }) as Awaited<ReturnType<HostService["status"]>>;
    assert.equal(after.settingsRevision, before.settingsRevision);
    assert.equal(signal.aborted, false);
  }
  finish.resolve();
  assert.deepEqual(await translation, [{ id: "a", text: "完成" }]);
  assert.equal(previews.length, 2, "presentation saves do not suppress later stream output");
});

test("a pending generation save gates final results and serializes subsequent saves", async () => {
  const settings = new FakeSettings();
  const started = deferred();
  const finishModel = deferred();
  const saving = deferred();
  const commitSave = deferred();
  const save = settings.save.bind(settings);
  let saves = 0;
  settings.save = async (input) => {
    saves += 1;
    if (saves === 1) { saving.resolve(); await commitSave.promise; }
    return save(input);
  };
  const service = serviceWith(settings, new FakeAuth(), {
    async translate(_settings, blocks) { started.resolve(); await finishModel.promise; return blocks.map(({ id }) => ({ id, text: "late old model" })); },
  });
  const before = await service.status();
  const translation = service.handle({ type: "translate", jobId: "pending-save", settingsRevision: before.settingsRevision, blocks: [{ id: "a", text: "Paragraph" }] });
  const rejected = assert.rejects(translation, expectCode("CANCELLED"));
  await started.promise;
  const first = service.handle({ type: "settings.save", settings: { ...settings.value, targetLanguage: "ja" } });
  await saving.promise;
  const second = service.handle({ type: "settings.save", settings: { ...settings.value, targetLanguage: "en" } });
  finishModel.resolve();
  let translationSettled = false;
  void translation.then(() => { translationSettled = true; }, () => { translationSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saves, 1, "later saves cannot overtake a pending write");
  assert.equal(translationSettled, false, "provider completion waits for configuration commit");
  commitSave.resolve();
  await Promise.all([first, second, rejected]);
  assert.equal(settings.value.targetLanguage, "en");
  assert.equal(saves, 2);
  await assert.rejects(service.handle({ type: "translate", jobId: "stale-after-save", settingsRevision: before.settingsRevision, blocks: [{ id: "a", text: "Paragraph" }] }), expectCode("CONFIG_REQUIRED"));
});

test("a failed settings save leaves active translation usable", async () => {
  const settings = new FakeSettings();
  settings.save = async () => { throw new AppError("STORAGE_ERROR", "保存失败"); };
  const started = deferred();
  const finish = deferred();
  let signal!: AbortSignal;
  const service = serviceWith(settings, new FakeAuth(), {
    async translate(_settings, blocks, currentSignal) { signal = currentSignal; started.resolve(); await finish.promise; return blocks.map(({ id }) => ({ id, text: "结果" })); },
  });
  const status = await service.status();
  const translation = service.handle({ type: "translate", jobId: "failed-save", settingsRevision: status.settingsRevision, blocks: [{ id: "a", text: "Paragraph" }] });
  await started.promise;
  await assert.rejects(service.handle({ type: "settings.save", settings: { ...settings.value, customModel: "different" } }), expectCode("STORAGE_ERROR"));
  assert.equal(signal.aborted, false);
  finish.resolve();
  assert.deepEqual(await translation, [{ id: "a", text: "结果" }]);
});

test("stopping translation interrupts a pending settings barrier without waiting for disk persistence", async (t) => {
  const settings = new FakeSettings();
  const started = deferred();
  const finishModel = deferred();
  const saving = deferred();
  const commit = deferred();
  t.after(() => commit.resolve());
  const save = settings.save.bind(settings);
  settings.save = async (input) => { saving.resolve(); await commit.promise; return save(input); };
  const service = serviceWith(settings, new FakeAuth(), {
    async translate(_settings, blocks) { started.resolve(); await finishModel.promise; return blocks.map(({ id }) => ({ id, text: "完成" })); },
  });
  const initial = await service.status();
  const result = service.handle({ type: "translate", jobId: "stop-during-save", settingsRevision: initial.settingsRevision, blocks: [{ id: "a", text: "Text" }] });
  const rejected = assert.rejects(result, expectCode("CANCELLED"));
  await started.promise;
  const pendingSave = service.handle({ type: "settings.save", settings: { ...settings.value, displayMode: "translation-only" } });
  await saving.promise;
  finishModel.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await service.handle({ type: "translate.cancel", jobId: "stop-during-save" });
  await rejected;
  commit.resolve();
  await pendingSave;
});
