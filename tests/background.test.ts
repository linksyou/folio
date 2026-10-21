import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type {
  ExtensionRequest,
  HostCommand,
  HostStatus,
  NativeMessage,
  NativeRequest,
  PageAction,
  PageCommand,
  Result,
  Translation,
} from "../src/shared/protocol.js";

const status: HostStatus = {
  protocolVersion: 1,
  settingsRevision: "revision",
  settings: {
    provider: "custom",
    chatgptModel: "",
    customBaseUrl: "https://custom.test/v1",
    customModel: "model",
    hasApiKey: true,
  },
  auth: { state: "signed_out", profiles: [], planEnabled: false },
};
const oldRoute = { tabId: 7, documentId: "old-document", jobId: "old-job", settingsRevision: "revision" };
let harnessSequence = 0;

const batchRequest = (jobId: string, batchId: string, id = "one"): ExtensionRequest => ({
  type: "translate.batch", jobId, batchId, settingsRevision: "revision", blocks: [{ id, text: "A paragraph shared by two reading requests." }],
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function background(t: TestContext, hooks: {
  beforeStatus?: () => Promise<void>;
  beforeInjection?: () => Promise<void>;
  beforeRouteWrite?: () => Promise<void>;
  hostStatus?: HostStatus;
  permission?: boolean;
  permissionRemoveFailure?: boolean;
  initialOrigins?: string[];
  pageFailure?: () => string | undefined;
  beforeRouteRemove?: () => Promise<void>;
  beforeCancel?: () => Promise<void>;
  beforeSessionGet?: (key: string | null) => Promise<void>;
  translate?: (command: Extract<HostCommand, { type: "translate" }>) => Promise<Translation[]>;
} = {}) {
  const originalChrome = globalThis.chrome;
  const originalSetTimeout = globalThis.setTimeout;
  const session = new Map<string, unknown>([["translation:7", oldRoute]]);
  const local = new Map<string, unknown>([["autoTranslateOrigins", hooks.initialOrigins ?? []]]);
  const registrations = new Map<string, chrome.scripting.RegisteredContentScript>();
  let permission = hooks.permission ?? false;
  let tabUrl = "https://article.test/read";
  let commandListener!: (command: string, tab: chrome.tabs.Tab) => void;
  let permissionsRemoved!: () => void;
  const nativeCommands: HostCommand[] = [];
  const pageCommands: PageCommand[] = [];
  const pageTargets: { tabId: number; documentId?: string; frameId?: number }[] = [];
  let optionsOpened = 0;
  const ports: Array<{ disconnect(): void }> = [];
  let runtimeListener!: (
    message: ExtensionRequest,
    sender: chrome.runtime.MessageSender,
    reply: (value: Result<unknown>) => void,
  ) => boolean;
  let updated!: (tabId: number, change: chrome.tabs.OnUpdatedInfo) => void;
  let removed!: (tabId: number) => void;
  let injectionCount = 0;
  const mock = {
    runtime: {
      id: "background-test",
      getURL: (path: string) => `chrome-extension://background-test/${path}`,
      onMessage: { addListener(listener: typeof runtimeListener) { runtimeListener = listener; } },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      openOptionsPage: async () => { optionsOpened += 1; },
      connectNative() {
        let receive!: (message: NativeMessage) => void;
        let disconnect!: () => void;
        const port = {
          onMessage: { addListener(listener: typeof receive) { receive = listener; } },
          onDisconnect: { addListener(listener: typeof disconnect) { disconnect = listener; } },
          postMessage(request: NativeRequest) {
            nativeCommands.push(request.command);
            void (async () => {
              if (request.command.type === "status") await hooks.beforeStatus?.();
              if (request.command.type === "translate.cancel") await hooks.beforeCancel?.();
              receive({
                id: request.id,
                ok: true,
                result: request.command.type === "status" ? (hooks.hostStatus ?? status)
                  : request.command.type === "translate" ? await (hooks.translate?.(request.command)
                    ?? Promise.resolve(request.command.blocks.map((block) => ({ id: block.id, text: `译文：${block.text}` })))) : {},
              });
            })();
          },
          disconnect() { disconnect(); },
        };
        ports.push(port);
        return port;
      },
    },
    tabs: {
      query: async () => [{ id: 7, url: tabUrl }],
      sendMessage: async (tabId: number, command: PageCommand, target: { documentId?: string; frameId?: number }) => {
        const failure = hooks.pageFailure?.();
        if (failure) throw new Error(failure);
        pageCommands.push(command);
        pageTargets.push({ tabId, ...target });
        return { ok: true, result: { status: "idle", total: 0, completed: 0, failed: 0, message: "" } };
      },
      onUpdated: { addListener(listener: typeof updated) { updated = listener; } },
      onRemoved: { addListener(listener: typeof removed) { removed = listener; } },
    },
    commands: { onCommand: { addListener(listener: typeof commandListener) { commandListener = listener; } } },
    permissions: {
      contains: async () => permission,
      remove: async () => { if (hooks.permissionRemoveFailure) throw new Error("Cannot remove required permission"); permission = false; return true; },
      onRemoved: { addListener(listener: typeof permissionsRemoved) { permissionsRemoved = listener; } },
    },
    scripting: {
      getRegisteredContentScripts: async (filter?: { ids?: string[] }) => [...registrations.values()].filter((script) => !filter?.ids || filter.ids.includes(script.id)),
      registerContentScripts: async (scripts: chrome.scripting.RegisteredContentScript[]) => { scripts.forEach((script) => registrations.set(script.id, script)); },
      unregisterContentScripts: async ({ ids }: { ids: string[] }) => { ids.forEach((id) => registrations.delete(id)); },
      executeScript: async () => {
        injectionCount++;
        const documentId = `document-${injectionCount}`;
        await hooks.beforeInjection?.();
        return [{ documentId }];
      },
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: async (key: string) => ({ [key]: local.get(key) }),
        set: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) local.set(key, value); },
      },
      session: {
        get: async (key: string | null) => {
          await hooks.beforeSessionGet?.(key);
          return key === null ? Object.fromEntries(session) : ({ [key]: session.get(key) });
        },
        set: async (values: Record<string, unknown>) => {
          await hooks.beforeRouteWrite?.();
          for (const [key, value] of Object.entries(values)) session.set(key, value);
        },
        remove: async (key: string | string[]) => {
          if (key === "translation:7") await hooks.beforeRouteRemove?.();
          for (const item of Array.isArray(key) ? key : [key]) session.delete(item);
        },
      },
    },
  };
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: mock });
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = originalSetTimeout(...args);
    if (typeof args[1] === "number" && args[1] >= 5_000) timer.unref();
    return timer;
  }) as typeof setTimeout;
  t.after(() => {
    for (const port of ports) port.disconnect();
    globalThis.setTimeout = originalSetTimeout;
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
  });
  const module = new URL("../src/extension/background.ts", import.meta.url);
  module.searchParams.set("test", String(++harnessSequence));
  await import(module.href);
  const sender = { id: mock.runtime.id, url: mock.runtime.getURL("popup.html") };
  return {
    session, local, registrations,
    setUrl(url: string) { tabUrl = url; },
    revokePermission() { permission = false; permissionsRemoved(); },
    command(command: string) { commandListener(command, { id: 7, url: tabUrl } as chrome.tabs.Tab); },
    request(message: ExtensionRequest, content?: { documentId: string; url?: string; frameId?: number; tabId?: number; documentLifecycle?: string }) {
      const source = content ? { id: mock.runtime.id, frameId: content.frameId ?? 0, documentId: content.documentId, documentLifecycle: content.documentLifecycle, url: content.url ?? tabUrl, tab: { id: content.tabId ?? 7, url: tabUrl } } : sender;
      return new Promise<Result<unknown>>((resolve) => { runtimeListener(message, source as chrome.runtime.MessageSender, resolve); });
    },
    nativeCommands,
    pageCommands,
    pageTargets,
    get optionsOpened() { return optionsOpened; },
    get injectionCount() { return injectionCount; },
    update(change: chrome.tabs.OnUpdatedInfo) { updated(7, change); },
    remove() { removed(7); },
    send(action: PageAction) {
      return new Promise<Result<unknown>>((resolve) => {
        runtimeListener({ type: "page.action", action }, sender, resolve);
      });
    },
  };
}

test("status and injection start together but neither alone can start translation", async (t) => {
  for (const first of ["status", "injection"] as const) {
    await t.test(`${first} finishes first`, async (t) => {
      const statusReached = deferred();
      const injectionReached = deferred();
      const releaseStatus = deferred();
      const releaseInjection = deferred();
      const harness = await background(t, {
        beforeStatus: async () => { statusReached.resolve(); await releaseStatus.promise; },
        beforeInjection: async () => { injectionReached.resolve(); await releaseInjection.promise; },
      });
      const starting = harness.send("start");
      await flush();
      // Both hooks must have run before either preparation is allowed to finish.
      assert.equal(harness.injectionCount, 1);
      assert.equal(harness.nativeCommands.filter((command) => command.type === "status").length, 1);
      await Promise.all([statusReached.promise, injectionReached.promise]);
      assert.equal(harness.pageCommands.length, 0);
      assert.equal(harness.session.get("translation:7"), oldRoute);

      (first === "status" ? releaseStatus : releaseInjection).resolve();
      await flush();
      assert.equal(harness.pageCommands.length, 0);
      assert.equal(harness.session.get("translation:7"), oldRoute);

      (first === "status" ? releaseInjection : releaseStatus).resolve();
      assert.equal((await starting).ok, true);
      assert.deepEqual(harness.pageCommands.map((command) => command.action), ["start"]);
      assert.notEqual(harness.session.get("translation:7"), oldRoute);
    });
  }
});

test("parallel injection never dispatches a page command when configuration is invalid", async (t) => {
  const harness = await background(t, {
    hostStatus: { ...status, settings: { ...status.settings, customModel: "" } },
  });
  const result = await harness.send("start");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CONFIG_REQUIRED");
  assert.equal(harness.injectionCount, 1);
  assert.equal(harness.pageCommands.length, 0);
  assert.equal(harness.session.get("translation:7"), oldRoute);
});

test("a failed parallel injection leaves the previous route untouched", async (t) => {
  const harness = await background(t, {
    beforeInjection: async () => { throw new Error("Page cannot be accessed"); },
  });
  const result = await harness.send("start");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PAGE_UNAVAILABLE");
  assert.equal(harness.pageCommands.length, 0);
  assert.equal(harness.session.get("translation:7"), oldRoute);
});

test("stop and restore invalidate starts waiting for status or content injection", async (t) => {
  for (const action of ["stop", "restore"] as const) {
    for (const stage of ["beforeStatus", "beforeInjection"] as const) {
      await t.test(`${action} during ${stage}`, async (t) => {
        const reached = deferred();
        const release = deferred();
        const harness = await background(t, {
          [stage]: async () => { reached.resolve(); await release.promise; },
        });
        const starting = harness.send("retranslate");
        await reached.promise;
        assert.equal((await harness.send(action)).ok, true);
        await flush();
        assert.ok(harness.nativeCommands.some((command) =>
          command.type === "translate.cancel" && command.jobId === oldRoute.jobId,
        ));
        release.resolve();
        const result = await starting;
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "CANCELLED");
        assert.deepEqual(harness.pageCommands.map((command) => command.action), [action]);
        assert.equal(harness.session.has("translation:7"), false);
      });
    }
  }
});

test("a new start does not wait for invalidated starts and their late completion cannot replace its route", async (t) => {
  const reached = deferred();
  const release = deferred();
  let injection = 0;
  const harness = await background(t, {
    beforeInjection: async () => {
      if (++injection === 1) { reached.resolve(); await release.promise; }
    },
  });
  const first = harness.send("retranslate");
  await reached.promise;
  const queued = harness.send("start");
  await flush();
  assert.equal(harness.injectionCount, 1);
  await harness.send("stop");
  const fresh = await harness.send("start");
  assert.equal(fresh.ok, true);
  const currentRoute = harness.session.get("translation:7");
  assert.ok(currentRoute);
  release.resolve();
  assert.equal((await first).ok, false);
  assert.equal((await queued).ok, false);
  assert.deepEqual(harness.pageCommands.map((command) => command.action), ["stop", "start"]);
  assert.equal(harness.session.get("translation:7"), currentRoute);
});

test("restore during a route write prevents page dispatch and removes the unpublished job", async (t) => {
  const reached = deferred();
  const release = deferred();
  const harness = await background(t, {
    beforeRouteWrite: async () => { reached.resolve(); await release.promise; },
  });
  const starting = harness.send("retranslate");
  await reached.promise;
  await harness.send("restore");
  release.resolve();
  const result = await starting;
  assert.equal(result.ok, false);
  await flush();
  assert.deepEqual(harness.pageCommands.map((command) => command.action), ["restore"]);
  assert.equal(harness.session.has("translation:7"), false);
  assert.equal(harness.nativeCommands.filter((command) => command.type === "translate.cancel").length, 2);
});

test("top-level loading cancels the old route and pending start while unrelated tab updates do not", async (t) => {
  const reached = deferred();
  const release = deferred();
  const harness = await background(t, {
    beforeStatus: async () => { reached.resolve(); await release.promise; },
  });
  harness.update({ title: "New title" });
  harness.update({ status: "complete" });
  await flush();
  assert.equal(harness.session.get("translation:7"), oldRoute);
  assert.equal(harness.nativeCommands.length, 0);
  const starting = harness.send("start");
  await reached.promise;
  // Both cross-document navigation and same-URL reload report tab loading.
  harness.update({ status: "loading" });
  await flush();
  assert.ok(harness.nativeCommands.some((command) =>
    command.type === "translate.cancel" && command.jobId === oldRoute.jobId,
  ));
  assert.equal(harness.session.has("translation:7"), false);
  release.resolve();
  const result = await starting;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CANCELLED");
  assert.equal(harness.pageCommands.length, 0);
  assert.equal(harness.injectionCount, 1);
});

test("closing a tab invalidates its pending start before removing the route", async (t) => {
  const reached = deferred();
  const release = deferred();
  const harness = await background(t, {
    beforeInjection: async () => { reached.resolve(); await release.promise; },
  });
  const starting = harness.send("start");
  await reached.promise;
  harness.remove();
  await flush();
  release.resolve();
  assert.equal((await starting).ok, false);
  assert.equal(harness.session.has("translation:7"), false);
  assert.equal(harness.pageCommands.length, 0);
});

test("automatic rule needs runtime permission and registers only the exact active origin", async (t) => {
  const denied = await background(t);
  const result = await denied.request({ type: "site.set", origin: "https://article.test", enabled: true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PERMISSION_REQUIRED");
  assert.deepEqual(denied.local.get("autoTranslateOrigins"), []);
  assert.equal(denied.registrations.size, 0);
});

test("automatic rule rejects stale active site, persists registration, and removes it on disable", async (t) => {
  const harness = await background(t, { permission: true });
  assert.equal((await harness.request({ type: "site.set", origin: "https://other.test", enabled: true })).ok, false);
  assert.equal((await harness.request({ type: "site.set", origin: "https://article.test", enabled: true })).ok, true);
  assert.deepEqual(harness.local.get("autoTranslateOrigins"), ["https://article.test"]);
  const [registration] = [...harness.registrations.values()];
  assert.deepEqual(registration.matches, ["https://article.test:443/*"]);
  assert.equal(registration.allFrames, false);
  assert.equal(registration.persistAcrossSessions, true);
  assert.equal(harness.pageCommands.length, 0, "rule registration itself does not extract text");
  await harness.request({ type: "site.set", origin: "https://article.test", enabled: false });
  assert.deepEqual(harness.local.get("autoTranslateOrigins"), []);
  assert.equal(harness.registrations.size, 0);
});

test("automatic handshake requires both a saved rule and permission, and only runs in the top document", async (t) => {
  for (const [permission, initialOrigins] of [[false, ["https://article.test"]], [true, []]] as const) {
    await t.test(`${permission}/${initialOrigins.length}`, async (t) => {
      const harness = await background(t, { permission, initialOrigins: [...initialOrigins] });
      await harness.request({ type: "page.ready" }, { documentId: "new-document" });
      assert.equal(harness.pageCommands.length, 0);
      assert.equal(harness.nativeCommands.length, 0);
    });
  }
  await t.test("authorized document", async (t) => {
    const harness = await background(t, { permission: true, initialOrigins: ["https://article.test"] });
    assert.equal((await harness.request({ type: "page.ready" }, { documentId: "new-document", frameId: 1 })).ok, false);
    assert.equal((await harness.request({ type: "page.ready" }, { documentId: "new-document" })).ok, true);
    assert.equal(harness.injectionCount, 0, "dynamic content is already installed");
    assert.equal(harness.pageCommands.at(-1)?.action, "start");
    assert.equal((harness.session.get("translation:7") as { documentId: string }).documentId, "new-document");
    await harness.request({ type: "page.ready" }, { documentId: "new-document" });
    assert.equal(harness.pageCommands.length, 1, "duplicate handshake cannot restart the document");
  });
});

test("manual document intent continues across same-origin SPA loading with a new job", async (t) => {
  const harness = await background(t);
  await harness.send("start");
  const first = harness.session.get("translation:7") as { documentId: string; jobId: string };
  harness.setUrl("https://article.test/next");
  harness.update({ status: "loading" });
  const result = await harness.request({ type: "page.navigate", url: "https://article.test/next", navigationId: 1 }, { documentId: first.documentId });
  assert.equal(result.ok, true);
  const next = harness.session.get("translation:7") as { documentId: string; jobId: string };
  assert.equal(next.documentId, first.documentId);
  assert.notEqual(next.jobId, first.jobId);
  assert.equal(harness.injectionCount, 1);
  assert.deepEqual(harness.pageCommands.map((command) => command.action), ["start", "start"]);
  assert.equal((await harness.request({ type: "translate.cancel", jobId: first.jobId }, { documentId: first.documentId })).ok, false);
});

test("stop and restore end same-document continuation and automatic handshakes cannot revive it", async (t) => {
  for (const action of ["stop", "restore"] as const) {
    await t.test(action, async (t) => {
      const harness = await background(t, { permission: true, initialOrigins: ["https://article.test"] });
      await harness.send("start");
      await harness.send(action);
      await flush();
      harness.setUrl("https://article.test/next");
      harness.update({ status: "loading" });
      const result = await harness.request({ type: "page.navigate", url: "https://article.test/next", navigationId: 1 }, { documentId: "document-1" });
      assert.equal(result.ok, false);
      await harness.request({ type: "page.ready" }, { documentId: "document-1" });
      assert.deepEqual(harness.pageCommands.map((command) => command.action), ["start", action]);
      assert.equal((await harness.request({ type: "page.ready" }, { documentId: "new-document" })).ok, true);
      assert.equal(harness.pageCommands.at(-1)?.action, "start", "a new authorized document may auto-translate");
    });
  }
});

test("SPA continuation rejects other documents, other origins, and older route sequences", async (t) => {
  const harness = await background(t);
  await harness.send("start");
  harness.setUrl("https://article.test/third");
  const navigate = { type: "page.navigate", url: "https://article.test/third", navigationId: 3 } as const;
  assert.equal((await harness.request(navigate, { documentId: "other-document" })).ok, false);
  assert.equal((await harness.request(navigate, { documentId: "document-1" })).ok, true);
  assert.equal((await harness.request({ ...navigate, navigationId: 2 }, { documentId: "document-1" })).ok, false);
  harness.setUrl("https://other.test/third");
  assert.equal((await harness.request({ ...navigate, url: "https://other.test/third", navigationId: 4 }, { documentId: "document-1" })).ok, false);
  assert.equal(harness.pageCommands.length, 2);
});

test("new-document automatic handshake waits behind loading cleanup and retains its fresh route", async (t) => {
  const reached = deferred();
  const release = deferred();
  let removals = 0;
  const harness = await background(t, {
    permission: true, initialOrigins: ["https://article.test"],
    beforeRouteRemove: async () => { if (++removals === 1) { reached.resolve(); await release.promise; } },
  });
  harness.update({ status: "loading" });
  await reached.promise;
  const starting = harness.request({ type: "page.ready" }, { documentId: "new-document" });
  await flush();
  assert.equal(harness.pageCommands.length, 0);
  release.resolve();
  assert.equal((await starting).ok, true);
  assert.equal((harness.session.get("translation:7") as { documentId: string }).documentId, "new-document");
});

test("stop and newer navigations invalidate delayed SPA preparation", async (t) => {
  const reached = deferred();
  const release = deferred();
  let statuses = 0;
  const harness = await background(t, {
    beforeStatus: async () => { if (++statuses === 2) { reached.resolve(); await release.promise; } },
  });
  await harness.send("start");
  harness.setUrl("https://article.test/second");
  const second = harness.request({ type: "page.navigate", url: "https://article.test/second", navigationId: 1 }, { documentId: "document-1" });
  await reached.promise;
  harness.setUrl("https://article.test/third");
  assert.equal((await harness.request({ type: "page.navigate", url: "https://article.test/third", navigationId: 2 }, { documentId: "document-1" })).ok, true);
  const newest = harness.session.get("translation:7");
  release.resolve();
  assert.equal((await second).ok, false);
  assert.equal(harness.session.get("translation:7"), newest);
  assert.equal((await harness.request({ type: "page.navigate", url: "https://article.test/third", navigationId: 1 }, { documentId: "document-1" })).ok, false);
});

test("outside permission revocation removes authority and stops existing document intent", async (t) => {
  const harness = await background(t, { permission: true });
  await harness.request({ type: "site.set", origin: "https://article.test", enabled: true });
  await harness.request({ type: "page.ready" }, { documentId: "new-document" });
  harness.revokePermission();
  await flush();
  await flush();
  assert.deepEqual(harness.local.get("autoTranslateOrigins"), []);
  assert.equal(harness.registrations.size, 0);
  assert.equal((harness.session.get("intent:7") as { continuing: boolean }).continuing, false);
  assert.equal(harness.session.has("translation:7"), false);
});

test("shortcut commands use the same start and restore route", async (t) => {
  const harness = await background(t);
  harness.command("translate-page");
  await flush();
  assert.equal(harness.pageCommands.at(-1)?.action, "start");
  harness.command("restore-page");
  await flush();
  assert.equal(harness.pageCommands.at(-1)?.action, "restore");
  assert.equal((harness.session.get("intent:7") as { continuing: boolean }).continuing, false);
});

test("missing content with an active route is reported rather than disguised as idle", async (t) => {
  const harness = await background(t, { pageFailure: () => "Receiving end does not exist" });
  const result = await harness.send("status");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PAGE_UNAVAILABLE");
});

test("permission revocation while the first automatic route is publishing prevents dispatch", async (t) => {
  const reached = deferred();
  const release = deferred();
  let writes = 0;
  const harness = await background(t, {
    permission: true, initialOrigins: ["https://article.test"],
    beforeRouteWrite: async () => { if (++writes === 1) { reached.resolve(); await release.promise; } },
  });
  const starting = harness.request({ type: "page.ready" }, { documentId: "new-document" });
  await reached.promise;
  harness.revokePermission();
  await flush();
  await flush();
  assert.deepEqual(harness.local.get("autoTranslateOrigins"), []);
  release.resolve();
  assert.equal((await starting).ok, false);
  assert.equal(harness.pageCommands.length, 0);
  assert.equal(harness.session.has("translation:7"), false);
  assert.equal((harness.session.get("intent:7") as { continuing: boolean }).continuing, false);
});

test("new documents reset the old SPA navigation sequence", async (t) => {
  const harness = await background(t, { permission: true, initialOrigins: ["https://article.test"] });
  await harness.send("start");
  harness.setUrl("https://article.test/old-route");
  await harness.request({ type: "page.navigate", url: "https://article.test/old-route", navigationId: 10 }, { documentId: "document-1" });
  harness.update({ status: "loading" });
  await harness.request({ type: "page.ready" }, { documentId: "new-document" });
  assert.equal((harness.session.get("intent:7") as { navigationId: number }).navigationId, 0);
  harness.setUrl("https://article.test/new-route");
  assert.equal((await harness.request({ type: "page.navigate", url: "https://article.test/new-route", navigationId: 1 }, { documentId: "new-document" })).ok, true);
});

test("BFcache restoration reauthorizes an enabled site but never resumes a stopped document", async (t) => {
  const harness = await background(t, { permission: true, initialOrigins: ["https://article.test"] });
  await harness.request({ type: "page.ready" }, { documentId: "document-1" });
  harness.update({ status: "loading" });
  assert.equal((await harness.request({ type: "page.ready", restored: true }, { documentId: "document-1" })).ok, true);
  assert.equal(harness.pageCommands.length, 2);
  await harness.send("stop");
  await flush();
  await harness.request({ type: "page.ready", restored: true }, { documentId: "document-1" });
  assert.deepEqual(harness.pageCommands.map((command) => command.action), ["start", "start", "stop"]);
});

test("SPA uses Chrome's current tab URL when sender.url still names the initial document URL", async (t) => {
  const harness = await background(t);
  await harness.send("start");
  harness.setUrl("https://article.test/after-push-state");
  const result = await harness.request({ type: "page.navigate", url: "https://article.test/after-push-state", navigationId: 1 }, {
    documentId: "document-1", url: "https://article.test/read",
  });
  assert.equal(result.ok, true);
  assert.equal((harness.session.get("intent:7") as { url: string }).url, "https://article.test/after-push-state");
});

test("disabling stops local authority even if Chrome refuses to remove a required permission", async (t) => {
  const harness = await background(t, { permission: true, permissionRemoveFailure: true });
  await harness.request({ type: "site.set", origin: "https://article.test", enabled: true });
  await harness.request({ type: "page.ready" }, { documentId: "document-1" });
  const result = await harness.request({ type: "site.set", origin: "https://article.test", enabled: false });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PERMISSION_REMOVE_FAILED");
  assert.deepEqual(harness.local.get("autoTranslateOrigins"), []);
  assert.equal(harness.registrations.size, 0);
  assert.equal((harness.session.get("intent:7") as { continuing: boolean }).continuing, false);
  assert.equal(harness.session.has("translation:7"), false);
  assert.equal(harness.pageCommands.at(-1)?.action, "stop");
  await harness.request({ type: "page.ready" }, { documentId: "new-document" });
  assert.equal(harness.pageCommands.at(-1)?.action, "stop", "required permission alone cannot restart automatic translation");
});

test("background maps shared provider output back to each page batch and detaches only the cancelled subscriber", async (t) => {
  const reached = deferred();
  const release = deferred();
  const harness = await background(t, { translate: async (command) => {
    reached.resolve(); await release.promise;
    return command.blocks.map(({ id }) => ({ id, text: "共享的完整译文" }));
  } });
  await harness.send("start");
  const { jobId, documentId } = harness.session.get("translation:7") as typeof oldRoute;
  const first = harness.request(batchRequest(jobId, "first", "original-one"), { documentId });
  await reached.promise;
  const second = harness.request(batchRequest(jobId, "second", "original-two"), { documentId });
  let joined = false;
  for (let attempt = 0; attempt < 100 && !joined; attempt++) {
    await flush();
    const diagnostic = await harness.request({ type: "diagnostics.get" });
    joined = diagnostic.ok && (diagnostic.result as { background: Array<{ stage: string; batchId?: string }> }).background
      .some((event) => event.stage === "reuse.link" && event.batchId === "second");
  }
  assert(joined, "the second consumer must subscribe before the first is cancelled");
  const cancelled = await harness.request({ type: "translate.cancelBatch", jobId, batchId: "first" }, { documentId });
  assert.equal(cancelled.ok, true);
  const stopped = await first;
  assert.equal(stopped.ok, false);
  if (!stopped.ok) assert.equal(stopped.error.code, "CANCELLED");
  release.resolve();
  assert.deepEqual(await second, { ok: true, result: [{ id: "original-two", text: "共享的完整译文" }] });
  const translations = harness.nativeCommands.filter((command) => command.type === "translate");
  assert.equal(translations.length, 1);
  assert.notEqual(translations[0].jobId, jobId, "shared provider lifetime is independent of page job");
  assert(!harness.nativeCommands.some((command) => command.type === "translate.cancelBatch" && command.jobId === translations[0].jobId));
});

test("cancelling a batch while fresh status is pending prevents even starting shared work", async (t) => {
  const reached = deferred();
  const release = deferred();
  let gate = false;
  const harness = await background(t, { beforeStatus: async () => { if (gate) { reached.resolve(); await release.promise; } } });
  await harness.send("start");
  const { jobId, documentId } = harness.session.get("translation:7") as typeof oldRoute;
  gate = true;
  const pending = harness.request(batchRequest(jobId, "pending"), { documentId });
  await reached.promise;
  await harness.request({ type: "translate.cancelBatch", jobId, batchId: "pending" }, { documentId });
  release.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CANCELLED");
  assert(!harness.nativeCommands.some((command) => command.type === "translate"));
});

test("changed generation configuration cannot be bypassed by the cache path", async (t) => {
  const currentStatus = structuredClone(status);
  const harness = await background(t, { hostStatus: currentStatus });
  await harness.send("start");
  const { jobId, documentId } = harness.session.get("translation:7") as typeof oldRoute;
  currentStatus.settingsRevision = "new-revision";
  const result = await harness.request(batchRequest(jobId, "stale"), { documentId });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CONFIG_REQUIRED");
  assert(!harness.nativeCommands.some((command) => command.type === "translate"));
});

test("persistent cache settings are UI-only and exact origins are validated", async (t) => {
  const harness = await background(t);
  assert.equal((await harness.request({ type: "cache.set", enabled: false })).ok, true);
  assert.equal(harness.local.get("translationCacheEnabled"), false);
  assert.equal((await harness.request({ type: "cache.clear", origin: "https://article.test/path" })).ok, false);
  assert.equal((await harness.request({ type: "cache.clear" }, { documentId: "old-document" })).ok, false);
  assert.equal((await harness.request({ type: "cache.set", enabled: true }, { documentId: "old-document" })).ok, false);
  assert.equal(harness.local.get("translationCacheEnabled"), false);
});

test("a cancellation before batch registration remains final for that consumer", async (t) => {
  const harness = await background(t);
  await harness.send("start");
  const { jobId, documentId } = harness.session.get("translation:7") as typeof oldRoute;
  await harness.request({ type: "translate.cancelBatch", jobId, batchId: "early" }, { documentId });
  const result = await harness.request(batchRequest(jobId, "early"), { documentId });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CANCELLED");
  assert(!harness.nativeCommands.some((command) => command.type === "translate"));
});

test("a replaced job cannot attach new provider work while the old route awaits native cancellation", async (t) => {
  let gate = false;
  const reached = deferred();
  const release = deferred();
  const harness = await background(t, { beforeCancel: async () => { if (gate) { reached.resolve(); await release.promise; } } });
  await harness.send("start");
  const { jobId, documentId } = harness.session.get("translation:7") as typeof oldRoute;
  gate = true;
  const restarting = harness.send("retranslate");
  await reached.promise;
  const late = await harness.request(batchRequest(jobId, "late"), { documentId });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.error.code, "CANCELLED");
  assert(!harness.nativeCommands.some((command) => command.type === "translate"));
  release.resolve();
  assert.equal((await restarting).ok, true);
});

test("floating controls act on their sender tab and document rather than the active tab", async (t) => {
  const harness = await background(t);
  const sender = { documentId: "document-1", tabId: 8, documentLifecycle: "active" };
  assert.equal((await harness.request({ type: "page.control", action: "start" }, sender)).ok, true);
  assert.deepEqual(harness.pageTargets[0], { tabId: 8, documentId: "document-1" });
  assert.equal(harness.session.get("translation:7"), oldRoute, "another tab is untouched");
  assert.equal((await harness.request({ type: "page.control", action: "stop" }, sender)).ok, true);
  assert.deepEqual(harness.pageTargets.at(-1), { tabId: 8, documentId: "document-1" });
  assert.equal((await harness.request({ type: "page.openSettings" }, sender)).ok, true);
  assert.equal(harness.optionsOpened, 1);
});

test("floating controls reject subframes, foreign origins, inactive and stale documents", async (t) => {
  const harness = await background(t);
  for (const sender of [
    { documentId: "document-1", frameId: 1 },
    { documentId: "document-1", url: "https://foreign.test/" },
    { documentId: "document-1", documentLifecycle: "cached" },
  ]) {
    assert.equal((await harness.request({ type: "page.control", action: "start" }, sender)).ok, false);
    assert.equal((await harness.request({ type: "page.openSettings" }, sender)).ok, false);
  }
  assert.equal(harness.injectionCount, 0);
  harness.session.set("intent:7", { documentId: "new-document", origin: "https://article.test", url: "https://article.test/read", continuing: true, navigationId: 0 });
  assert.equal((await harness.request({ type: "page.control", action: "restore" }, { documentId: "old-document" })).ok, false);
  assert.equal(harness.session.get("translation:7"), oldRoute);
  assert.equal(harness.pageCommands.length, 0);
});

test("floating start verifies the injected document before replacing an existing job", async (t) => {
  const harness = await background(t);
  const reply = await harness.request({ type: "page.control", action: "start" }, { documentId: "departed-document" });
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, "CANCELLED");
  assert.equal(harness.session.get("translation:7"), oldRoute);
  assert.equal(harness.pageCommands.length, 0);
});

test("a floating stop delayed across navigation cannot cancel the replacement document", async (t) => {
  const reading = deferred();
  const release = deferred();
  let hold = true;
  const harness = await background(t, { beforeSessionGet: async (key) => {
    if (key === "translation:7" && hold) { hold = false; reading.resolve(); await release.promise; }
  } });
  const stopped = harness.request({ type: "page.control", action: "stop" }, { documentId: "old-document" });
  await reading.promise;
  harness.update({ status: "loading" });
  await flush();
  assert.equal((await harness.send("start")).ok, true);
  const replacement = harness.session.get("translation:7");
  release.resolve();
  assert.equal((await stopped).ok, false);
  await flush();
  assert.equal(harness.session.get("translation:7"), replacement);
  assert.equal(harness.pageCommands.filter((command) => command.action === "stop").length, 0);
});

test("floating settings remains reachable after a failed manual start with an old navigation intent", async (t) => {
  const harness = await background(t);
  harness.session.set("intent:7", { documentId: "previous-document", origin: "https://article.test", continuing: false });
  assert.equal((await harness.request({ type: "page.openSettings" }, { documentId: "current-document", documentLifecycle: "active" })).ok, true);
  assert.equal(harness.optionsOpened, 1);
});
