import { AppError, publicError } from "../shared/errors.js";
import { PROTOCOL_VERSION, type ExtensionRequest, type HostStatus, type PageAction, type PageState, type PageProgress } from "../shared/protocol.js";
import { validateCommand } from "../shared/validation.js";
import { NativeClient } from "./native-client.js";
import { TimingLog } from "../shared/diagnostics.js";
import { reconcileSiteRules, setSiteRule, siteForUrl, siteStatus } from "./site-rules.js";
import { TranslationCache } from "./translation-cache.js";
import { TranslationReuse } from "./translation-reuse.js";
import { CACHE_ENABLED_KEY, cacheEnabled } from "./cache-settings.js";
import { pageError } from "../shared/page-feedback.js";

const native = new NativeClient();
const timings = new TimingLog("background");
const reuse = new TranslationReuse(new TranslationCache(), {
  translate: (request, onProgress) => native.request({ type: "translate", ...request }, onProgress),
  cancel: async (jobId, batchId) => { await native.request({ type: "translate.cancelBatch", jobId, batchId }); },
}, { onLink: (link) => {
  pendingBatches.get(batchKey(link.jobId, link.batchId))?.groups.add(batchKey(link.providerJobId, link.providerBatchId));
  timings.mark("reuse.link", link);
} });
const pendingBatches = new Map<string, { jobId: string; token: symbol; groups: Set<string> }>();
const retiredJobs = new Set<string>();
function detachJob(jobId: string): void {
  retiredJobs.add(jobId);
  if (retiredJobs.size > 4_096) retiredJobs.delete(retiredJobs.values().next().value!);
  for (const [key, pending] of pendingBatches) if (pending.jobId === jobId) pendingBatches.delete(key);
  reuse.cancelJob(jobId);
}
const batchKey = (jobId: string, batchId: string) => JSON.stringify([jobId, batchId]);
const cancelledConsumers = new Set<string>();
function rememberCancellation(key: string): void {
  cancelledConsumers.add(key);
  if (cancelledConsumers.size > 4_096) cancelledConsumers.delete(cancelledConsumers.values().next().value!);
}
const emptyState: PageState = {
  status: "idle", total: 0, completed: 0, failed: 0, message: "点击翻译正文，开始双语阅读。",
};
interface Route { tabId: number; documentId: string; jobId: string; settingsRevision: string; url?: string; origin?: string; force?: boolean; incognito?: boolean }
interface Intent { documentId: string; origin: string; url: string; continuing: boolean; navigationId: number }
const intentKey = (tabId: number) => `intent:${tabId}`;
const errorKey = (tabId: number) => `pageError:${tabId}`;
async function intent(tabId: number): Promise<Intent | undefined> {
  return (await chrome.storage.session.get(intentKey(tabId)))[intentKey(tabId)] as Intent | undefined;
}
const routeKey = (tabId: number) => `translation:${tabId}`;
const pageStarts = new Map<number, Promise<unknown>>();
const pageEpochs = new Map<number, symbol>();
const routeUpdates = new Map<number, Promise<unknown>>();
const navigationSequences = new Map<number, { documentId: string; id: number }>();

function isUI(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && (sender.frameId === undefined || sender.frameId === 0) &&
    ["popup.html", "options.html"].some((file) => sender.url === chrome.runtime.getURL(file));
}

async function route(tabId: number): Promise<Route | undefined> {
  return (await chrome.storage.session.get(routeKey(tabId)))[routeKey(tabId)] as Route | undefined;
}

function pageEpoch(tabId: number): symbol {
  let epoch = pageEpochs.get(tabId);
  if (!epoch) {
    epoch = Symbol();
    pageEpochs.set(tabId, epoch);
  }
  return epoch;
}

function invalidateStarts(tabId: number): symbol {
  const epoch = Symbol();
  pageEpochs.set(tabId, epoch);
  // A new explicit start need not wait for an obsolete status/injection request.
  pageStarts.delete(tabId);
  return epoch;
}

function requireEpoch(tabId: number, epoch: symbol): void {
  if (pageEpochs.get(tabId) !== epoch) {
    throw new AppError("CANCELLED", "页面任务已停止或页面已变化。");
  }
}

/** Serialize route writes so delayed cleanup can never delete a newer route. */
async function updateRoute<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
  const previous = routeUpdates.get(tabId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  routeUpdates.set(tabId, current);
  try { return await current; }
  finally { if (routeUpdates.get(tabId) === current) routeUpdates.delete(tabId); }
}

async function cancelRoute(tabId: number, endIntent: "stop" | "clear" | false = false,
  expected?: { documentId: string; epoch: symbol }): Promise<void> {
  await updateRoute(tabId, async () => {
    const current = await route(tabId);
    const previous = endIntent === "stop" ? await intent(tabId) : undefined;
    if (expected) {
      requireEpoch(tabId, expected.epoch);
      if ((current && current.documentId !== expected.documentId) ||
          (previous && previous.documentId !== expected.documentId)) return;
    }
    if (endIntent === "clear") await chrome.storage.session.remove([intentKey(tabId), errorKey(tabId)]);
    else if (endIntent === "stop") {
      if (previous) await chrome.storage.session.set({ [intentKey(tabId)]: { ...previous, continuing: false } });
      await chrome.storage.session.remove(errorKey(tabId));
    }
    await chrome.storage.session.remove(routeKey(tabId));
    if (current) {
      detachJob(current.jobId);
      await native.request({ type: "translate.cancel", jobId: current.jobId }).catch(() => undefined);
    }
  });
}

async function startPageAction(
  tab: chrome.tabs.Tab,
  action: "start" | "retry" | "retranslate",
  epoch: symbol,
  options: { documentId?: string; expectedDocumentId?: string; navigationId?: number; automatic?: boolean; clickedAtEpochMs?: number } = {},
): Promise<unknown> {
  if (tab.id === undefined) throw new AppError("PAGE_UNAVAILABLE", "无法读取当前页面。");
  const tabId = tab.id;
  const started = performance.now();
  timings.mark("start.received");
  requireEpoch(tabId, epoch);
  if (!tab.url || !/^https?:/.test(tab.url)) {
    throw new AppError("PAGE_UNAVAILABLE", "首版支持普通 HTTP/HTTPS 网页，浏览器内部页面和 PDF 暂不支持。");
  }
  // Injection only installs the page listener and observer; it does not read or
  // send page text until the validated page.command below.
  const [statusResult, injectedResult] = await Promise.allSettled([
    native.request<HostStatus>({ type: "status" }),
    options.documentId ? Promise.resolve([{ documentId: options.documentId }]) : chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => {
      throw new AppError("PAGE_UNAVAILABLE", "当前页面不允许扩展访问，请在普通网页上重试。");
    }),
  ]);
  requireEpoch(tabId, epoch);
  // Install the content listener even when Host preflight fails, so the reader
  // can recover on the page and a reopened popup sees the same error.
  if (injectedResult.status === "rejected") throw injectedResult.reason;
  if (statusResult.status === "rejected") throw statusResult.reason;
  const status = statusResult.value;
  const injected = injectedResult.value;
  if (status.protocolVersion !== PROTOCOL_VERSION) {
    throw new AppError("CONFIG_REQUIRED", "请重新构建并安装匹配版本的本地辅助程序。");
  }
  if (status.settings.provider === "chatgpt") {
    if (status.auth.state !== "signed_in") throw new AppError("AUTH_REQUIRED", "请先在设置中登录 ChatGPT。");
    if (!status.auth.planEnabled) throw new AppError("PLAN_DISABLED", "当前账号尚未启用 ChatGPT 方案额度。");
    if (!status.settings.chatgptModel) throw new AppError("CONFIG_REQUIRED", "请先在设置中选择并保存模型。");
  } else if (!status.settings.customBaseUrl || !status.settings.customModel) {
    throw new AppError("CONFIG_REQUIRED", "请先在设置中填写并保存 API 地址和模型。");
  }
  const documentId = injected[0]?.documentId;
  if (!documentId) throw new AppError("PAGE_UNAVAILABLE", "页面已变化，请重试。");
  if (options.expectedDocumentId && documentId !== options.expectedDocumentId) {
    throw new AppError("CANCELLED", "页面已变化，请在当前网页重新操作。");
  }
  const targetDocument = documentId;
  return updateRoute(tabId, async () => {
    requireEpoch(tabId, epoch);
    const previous = await route(tabId);
    const previousIntent = await intent(tabId);
    requireEpoch(tabId, epoch);
    if (previous?.documentId === targetDocument && action !== "retranslate") {
      const current = await chrome.tabs.sendMessage(tabId, { type: "page.command", action: "status" }, { documentId: targetDocument });
      requireEpoch(tabId, epoch);
      const state: PageState | undefined = current?.ok ? current.result : undefined;
      if (state && (state.status === "running" || action === "retry"
        && state.status === "completed" && state.failed === 0)) return state;
    }
    if (options.documentId && previousIntent &&
        (previousIntent.documentId === options.documentId ? !previousIntent.continuing : !options.automatic)) {
      throw new AppError("CANCELLED", "此页面的持续翻译已结束。");
    }
    if (options.automatic && !(await siteStatus(tab.url)).enabled) {
      throw new AppError("PERMISSION_REQUIRED", "此网站的自动翻译已关闭或访问权限已撤销。");
    }
    requireEpoch(tabId, epoch);
    if (previous) {
      detachJob(previous.jobId);
      await native.request({ type: "translate.cancel", jobId: previous.jobId });
    }
    requireEpoch(tabId, epoch);
    const next: Route = {
      tabId, documentId: targetDocument, jobId: crypto.randomUUID(), settingsRevision: status.settingsRevision,
      url: tab.url, origin: siteForUrl(tab.url)!.origin, force: action === "retranslate", incognito: tab.incognito,
    };
    const nextIntent: Intent = {
      documentId: targetDocument, origin: siteForUrl(tab.url)!.origin, url: tab.url!, continuing: true,
      navigationId: options.navigationId ?? (previousIntent?.documentId === targetDocument ? previousIntent.navigationId : 0),
    };
    await chrome.storage.session.set({ [routeKey(tabId)]: next, [intentKey(tabId)]: nextIntent });
    await chrome.storage.session.remove(errorKey(tabId));
    timings.mark("page.dispatch", { jobId: next.jobId }, { preparationMs: performance.now() - started });
    requireEpoch(tabId, epoch);
    try {
      // Revocation can finish while storage.set is still publishing the first
      // intent. Recheck after publication, when revocation cleanup can see it.
      if (options.automatic && !(await siteStatus(tab.url)).enabled) {
        await chrome.storage.session.set({ [intentKey(tabId)]: { ...nextIntent, continuing: false } });
        throw new AppError("PERMISSION_REQUIRED", "此网站的自动翻译已关闭或访问权限已撤销。");
      }
      requireEpoch(tabId, epoch);
      const reply = await chrome.tabs.sendMessage(tabId, {
        type: "page.command", action, jobId: next.jobId, settingsRevision: next.settingsRevision,
        displayMode: status.settings.displayMode ?? "bilingual", url: nextIntent.url,
        targetLanguage: status.settings.targetLanguage ?? "zh-CN",
        ...(options.clickedAtEpochMs === undefined ? {} : { clickedAtEpochMs: options.clickedAtEpochMs }),
      }, { documentId: targetDocument });
      requireEpoch(tabId, epoch);
      if (!reply.ok) throw new AppError(reply.error.code, reply.error.message);
      return reply.result;
    } catch (error) {
      await chrome.storage.session.remove(routeKey(tabId));
      detachJob(next.jobId);
      void native.request({ type: "translate.cancel", jobId: next.jobId }).catch(() => undefined);
      throw error;
    }
  });
}

async function publishPageFailure(tabId: number, url: string | undefined, epoch: symbol, error: unknown, documentId?: string): Promise<void> {
  const failure = pageError(publicError(error));
  if (failure.code === "CANCELLED") return;
  await updateRoute(tabId, async () => {
    if (pageEpochs.get(tabId) !== epoch) return;
    await chrome.storage.session.set({ [errorKey(tabId)]: { error: failure, url } });
    if (pageEpochs.get(tabId) !== epoch) return;
    await chrome.tabs.sendMessage(tabId, { type: "page.failure", error: failure, url },
      documentId ? { documentId } : { frameId: 0 }).catch(() => undefined);
  });
}

async function pageAction(action: PageAction, tabOverride?: chrome.tabs.Tab, clickedAtEpochMs?: number, expectedDocumentId?: string): Promise<unknown> {
  const tab = tabOverride ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab?.id === undefined) throw new AppError("PAGE_UNAVAILABLE", "无法读取当前页面。");
  if (!siteForUrl(tab.url)) throw new AppError("PAGE_UNAVAILABLE", "此页面不支持翻译，请打开普通 HTTP/HTTPS 网页。");
  if (action === "status" || action === "stop" || action === "restore") {
    const beforeRead = pageEpoch(tab.id);
    const currentRoute = await route(tab.id);
    const currentIntent = expectedDocumentId ? await intent(tab.id) : undefined;
    if (expectedDocumentId) requireEpoch(tab.id, beforeRead);
    if (expectedDocumentId && ((currentRoute && currentRoute.documentId !== expectedDocumentId) ||
        (currentIntent && currentIntent.documentId !== expectedDocumentId))) {
      throw new AppError("CANCELLED", "页面任务已变化。");
    }
    if (action !== "status") {
      const epoch = invalidateStarts(tab.id);
      // Do not wait for the host to acknowledge cancellation before updating the page.
      void cancelRoute(tab.id, "stop", expectedDocumentId ? { documentId: expectedDocumentId, epoch } : undefined).catch(() => undefined);
    }
    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, { type: "page.command", action }, expectedDocumentId ? { documentId: expectedDocumentId } : { frameId: 0 });
    } catch {
      if (action === "status") {
        const failure = (await chrome.storage.session.get(errorKey(tab.id)))[errorKey(tab.id)] as
          { error?: { code: string }; url?: string } | undefined;
        if (failure?.error && failure.url === tab.url) return {
          ...emptyState, status: "paused", continuing: false, error: pageError(failure.error),
          message: pageError(failure.error).message,
        };
      }
      if (currentRoute) throw new AppError("PAGE_UNAVAILABLE", "页面连接已中断，请刷新网页后重试。");
      if (action === "status") return emptyState;
      return { ...emptyState, status: action === "stop" ? "stopped" : "idle", message: action === "stop" ? "已停止此页面的持续翻译。" : "已恢复原文。" };
    }
    if (!result?.ok) throw new AppError(result?.error?.code ?? "PAGE_UNAVAILABLE", result?.error?.message ?? "无法读取页面状态。");
    return result.result;
  }
  if (action !== "start" && action !== "retry" && action !== "retranslate") throw new AppError("INVALID_REQUEST", "无法识别此操作。");
  const epoch = pageEpoch(tab.id);
  // Coalesce concurrent gestures; queuing starts would cancel the first retry.
  const previous = pageStarts.get(tab.id);
  if (previous) return previous;
  const current = startPageAction(tab, action, epoch, { clickedAtEpochMs, expectedDocumentId });
  pageStarts.set(tab.id, current);
  try { return await current; }
  catch (error) {
    await publishPageFailure(tab.id, tab.url, epoch, error, expectedDocumentId);
    throw error;
  }
  finally { if (pageStarts.get(tab.id) === current) pageStarts.delete(tab.id); }
}

async function automaticPage(message: Extract<ExtensionRequest, { type: "page.ready" | "page.navigate" }>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = sender.tab!.id!;
  const epoch = pageEpoch(tabId);
  const currentIntent = await intent(tabId);
  requireEpoch(tabId, epoch);
  // Chrome keeps sender.url at the document's initial URL after pushState;
  // sender.tab.url is the browser's current top-level URL (verified in Chrome).
  const url = sender.tab!.url;
  const site = siteForUrl(url);
  if (!site || siteForUrl(sender.url)?.origin !== site.origin ||
      (sender.documentLifecycle && sender.documentLifecycle !== "active")) return { accepted: false };
  if (message.type === "page.ready") {
    // Programmatic manual injection also sends this handshake. It must not race
    // the user's already queued start or restart a stopped document.
    if (pageStarts.has(tabId) || (currentIntent && currentIntent.documentId === sender.documentId &&
        (!message.restored || !currentIntent.continuing))) return { accepted: false };
    if (!(await siteStatus(url)).enabled) return { accepted: false };
    requireEpoch(tabId, epoch);
    const starting = startPageAction({ ...sender.tab!, url }, "start", epoch, { documentId: sender.documentId, automatic: true });
    pageStarts.set(tabId, starting);
    try { return await starting; }
    finally { if (pageStarts.get(tabId) === starting) pageStarts.delete(tabId); }
  }
  const latestNavigation = navigationSequences.get(tabId);
  const lastNavigationId = Math.max(currentIntent?.navigationId ?? 0,
    latestNavigation && latestNavigation.documentId === sender.documentId ? latestNavigation.id : 0);
  timings.mark("navigation.received", {}, {
    sameDocument: currentIntent?.documentId === sender.documentId,
    sameSenderUrl: message.url === sender.url,
    sameSenderTabUrl: message.url === sender.tab?.url,
    continuing: currentIntent?.continuing ?? false,
    navigationId: message.navigationId,
    lastNavigationId,
  });
  if (!currentIntent?.continuing || currentIntent.documentId !== sender.documentId ||
      currentIntent.origin !== site.origin || message.url !== url ||
      !Number.isSafeInteger(message.navigationId) || message.navigationId <= lastNavigationId) {
    throw new AppError("CANCELLED", "页面任务已停止或导航已过期。");
  }
  navigationSequences.set(tabId, { documentId: sender.documentId!, id: message.navigationId });
  const nextEpoch = invalidateStarts(tabId);
  // The new route must be visible before it can request any text; serialize
  // cancellation and publication so late cleanup cannot remove its identity.
  void cancelRoute(tabId).catch(() => undefined);
  try {
    return await startPageAction({ ...sender.tab!, url }, "start", nextEpoch, {
      documentId: sender.documentId, navigationId: message.navigationId,
    });
  } catch (error) {
    await publishPageFailure(tabId, url, nextEpoch, error, sender.documentId);
    throw error;
  }
}

async function stopOrigin(origin: string): Promise<void> {
  const values = await chrome.storage.session.get(null);
  await Promise.all(Object.entries(values).flatMap(([key, value]) => {
    if (!key.startsWith("intent:") || (value as Intent).origin !== origin) return [];
    const tabId = Number(key.slice("intent:".length));
    invalidateStarts(tabId);
    return [(async () => {
      const stopped = chrome.tabs.sendMessage(tabId, { type: "page.command", action: "stop" }, { documentId: (value as Intent).documentId }).catch(() => undefined);
      await cancelRoute(tabId, "stop");
      await stopped;
    })()];
  }));
}

async function handle(message: ExtensionRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (isUI(sender)) {
    if (message.type === "cache.status" || message.type === "cache.set" || message.type === "cache.clear") {
      if (message.type === "cache.set") {
        if (typeof message.enabled !== "boolean") throw new AppError("INVALID_REQUEST", "缓存设置无效。");
        await chrome.storage.local.set({ [CACHE_ENABLED_KEY]: message.enabled });
        reuse.setEnabled(message.enabled);
      } else if (message.type === "cache.clear") {
        if (message.origin !== undefined && (!siteForUrl(message.origin) || siteForUrl(message.origin)!.origin !== message.origin)) {
          throw new AppError("INVALID_REQUEST", "网站地址无效。");
        }
        await reuse.clear(message.origin);
      }
      return { enabled: await cacheEnabled(), ...await reuse.stats() };
    }
    if (message.type === "diagnostics.get") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [host, page] = await Promise.all([
        native.request({ type: "diagnostics.get" }).catch(() => []),
        tab?.id === undefined ? [] : chrome.tabs.sendMessage(tab.id, { type: "page.diagnostics" }, { frameId: 0 }).catch(() => []),
      ]);
      return {
        version: 1,
        clock: "atMs is monotonic and local to each layer/process; do not subtract across layers",
        clickTiming: "ui.firstVisible.values.clickToVisibleMs uses Date.now on the same machine from popup click to a newly visible translation; clock adjustments may affect it",
        background: timings.read(), host, page,
      };
    }
    if (message.type === "host.request") {
      validateCommand(message.command);
      if (message.command.type.startsWith("translate")) {
        throw new AppError("INVALID_REQUEST", "请从网页发起翻译。");
      }
      const result = await native.request(message.command);
      if (["settings.save", "auth.select", "auth.logout", "auth.login"].includes(message.command.type)) {
        const latest = await native.request<HostStatus>({ type: "status" });
        const values = await chrome.storage.session.get(null);
        for (const [key, value] of Object.entries(values)) {
          if (key.startsWith("translation:") && (value as Route).settingsRevision !== latest.settingsRevision) detachJob((value as Route).jobId);
        }
      }
      return result;
    }
    if (message.type === "site.status") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return siteStatus(tab?.url);
    }
    if (message.type === "site.set") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (siteForUrl(tab?.url)?.origin !== message.origin || typeof message.enabled !== "boolean") {
        throw new AppError("PAGE_CHANGED", "当前网站已变化，请重新打开扩展后操作。");
      }
      if (message.enabled) return setSiteRule(message.origin, true);
      // Local stopping must succeed even when Chrome cannot remove a permission
      // (for example an externally required grant in the integration fixture).
      try { return await setSiteRule(message.origin, false); }
      finally { await stopOrigin(message.origin); }
    }
    if (message.type === "page.action") {
      const click = message.clickedAtEpochMs;
      return pageAction(message.action, undefined, typeof click === "number" && Number.isFinite(click) && Math.abs(Date.now() - click) < 60_000 ? click : undefined);
    }
  }
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined ||
      !sender.documentId) throw new AppError("INVALID_REQUEST", "无法识别消息来源。");
  if (message.type === "page.control" || message.type === "page.openSettings") {
    const site = siteForUrl(sender.tab.url);
    if (!site || siteForUrl(sender.url)?.origin !== site.origin ||
        (sender.documentLifecycle && sender.documentLifecycle !== "active")) {
      throw new AppError("CANCELLED", "网页已变化，请在当前网页重新操作。");
    }
    if (message.type === "page.openSettings") {
      await chrome.runtime.openOptionsPage();
      return {};
    }
    const click = message.clickedAtEpochMs;
    return pageAction(message.action, sender.tab,
      typeof click === "number" && Number.isFinite(click) && Math.abs(Date.now() - click) < 60_000 ? click : undefined,
      sender.documentId);
  }
  if (message.type === "page.ready" || message.type === "page.navigate") {
    const epoch = pageEpoch(sender.tab.id);
    try { return await automaticPage(message, sender); }
    catch (error) {
      await publishPageFailure(sender.tab.id, sender.tab.url, epoch, error, sender.documentId);
      throw error;
    }
  }
  const epoch = pageEpoch(sender.tab.id);
  const consumerKey = (batchId?: string) => JSON.stringify([sender.tab!.id, sender.documentId, "jobId" in message ? message.jobId : "", batchId]);
  if (message.type === "translate.cancel" || message.type === "translate.cancelBatch") {
    validateCommand(message);
    // Remember before the first storage await: cancellation may precede a
    // batch's route lookup, so it has no subscriber to detach yet.
    rememberCancellation(consumerKey(message.type === "translate.cancelBatch" ? message.batchId : undefined));
  }
  const current = await route(sender.tab.id);
  if (!current || current.documentId !== sender.documentId ||
      !("jobId" in message) || current.jobId !== message.jobId) {
    throw new AppError("CANCELLED", "页面任务已变化。");
  }
  if (message.type === "translate.cancel") {
    detachJob(current.jobId);
    return native.request({ type: "translate.cancel", jobId: current.jobId });
  }
  if (message.type === "translate.cancelBatch") {
    validateCommand(message);
    pendingBatches.delete(batchKey(current.jobId, message.batchId));
    reuse.cancelBatch(current.jobId, message.batchId);
    return native.request(message);
  }
  if (message.type === "translate.batch" && message.settingsRevision === current.settingsRevision) {
    const command = { ...message, type: "translate" as const };
    validateCommand(command);
    const batchId = message.batchId ?? crypto.randomUUID();
    const key = batchKey(current.jobId, batchId);
    if (pendingBatches.has(key)) throw new AppError("INVALID_REQUEST", "翻译批次已在执行。");
    const token = Symbol();
    const pending = { jobId: current.jobId, token, groups: new Set<string>() };
    pendingBatches.set(key, pending);
    const assertCurrent = async () => {
      const latestRoute = await route(current.tabId);
      requireEpoch(current.tabId, epoch);
      if (pendingBatches.get(key)?.token !== token || latestRoute?.jobId !== current.jobId || latestRoute.documentId !== current.documentId) {
        throw new AppError("CANCELLED", "页面任务已变化。");
      }
      if (retiredJobs.has(current.jobId) || cancelledConsumers.has(consumerKey()) || cancelledConsumers.has(consumerKey(batchId))) {
        throw new AppError("CANCELLED", "页面批次已停止。");
      }
    };
    try {
      // Cache hits must pass the same generation identity check as model results.
      const [status, enabled] = await Promise.all([native.request<HostStatus>({ type: "status" }), cacheEnabled()]);
      if (status.settingsRevision !== current.settingsRevision) throw new AppError("CONFIG_REQUIRED", "翻译设置已变化，请重新开始。");
      await assertCurrent();
      const url = current.url ?? sender.tab.url ?? sender.url;
      const site = siteForUrl(url);
      if (!site || (current.origin && site.origin !== current.origin)) throw new AppError("CANCELLED", "页面地址已变化。");
      const result = await reuse.translate({
        jobId: current.jobId, batchId, settingsRevision: current.settingsRevision,
        origin: site.origin, url: url!, blocks: message.blocks, force: current.force,
        priority: message.priority, anchorFragment: message.anchorFragment === true,
        enabled: enabled && !current.incognito && !sender.tab.incognito,
      }, message.batchId ? (translations) => {
      // Route to this exact document. The content script also checks job/batch
      // identity, so an old stream cannot update a newer translation session.
      void chrome.tabs.sendMessage(current.tabId, {
        type: "translate.progress", jobId: current.jobId, batchId, translations,
      } satisfies PageProgress, { documentId: current.documentId }).catch(() => undefined);
      } : undefined);
      const finalStatus = await native.request<HostStatus>({ type: "status" });
      if (finalStatus.settingsRevision !== current.settingsRevision) throw new AppError("CONFIG_REQUIRED", "翻译设置已变化，请重新开始。");
      await assertCurrent();
      timings.mark("reuse.end", { jobId: current.jobId, batchId }, { success: true, blocks: result.length, providerGroups: pending.groups.size });
      return result;
    } catch (error) {
      timings.mark("reuse.end", { jobId: current.jobId, batchId }, { success: false, cancelled: publicError(error).code === "CANCELLED", providerGroups: pending.groups.size });
      throw error;
    } finally {
      if (pendingBatches.get(key)?.token === token) pendingBatches.delete(key);
    }
  }
  throw new AppError("INVALID_REQUEST", "无法识别此操作。");
}

chrome.runtime.onMessage.addListener((message: ExtensionRequest, sender, reply) => {
  void handle(message, sender).then(
    (result) => reply({ ok: true, result }),
    (error) => reply({ ok: false, error: publicError(error) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  navigationSequences.delete(tabId);
  const epoch = invalidateStarts(tabId);
  void cancelRoute(tabId, "clear").catch(() => undefined).finally(() => {
    if (pageEpochs.get(tabId) === epoch) pageEpochs.delete(tabId);
  });
});

// Tab loading covers top-level navigation and reload without webNavigation or
// tabs permissions. Ignore unrelated updates such as titles and loading finish.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "loading") return;
  invalidateStarts(tabId);
  // Loading is also observed during some same-document navigations. Retain the
  // intent bound to its exact document; page.ready can replace it only for a
  // different document whose origin still has an enabled automatic rule.
  void cancelRoute(tabId).catch(() => undefined);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "translate-page" && command !== "restore-page") return;
  void pageAction(command === "restore-page" ? "restore" : "start", tab, Date.now()).catch(() => undefined);
});

const reconcile = () => { void reconcileSiteRules().then((removed) => Promise.all(removed.map(stopOrigin))).catch(() => undefined); };
chrome.runtime.onStartup.addListener(reconcile);
chrome.runtime.onInstalled.addListener(reconcile);
chrome.permissions.onRemoved.addListener(reconcile);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CACHE_ENABLED_KEY]) reuse.setEnabled(changes[CACHE_ENABLED_KEY].newValue !== false);
});
