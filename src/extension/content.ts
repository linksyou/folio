import type {
  ExtensionRequest,
  PageCommand,
  PageProgress,
  PageState,
  Result,
  Translation,
} from "../shared/protocol.js";
import { PageTranslator, type TranslationTransport } from "./page/PageTranslator.js";
import { TimingLog } from "../shared/diagnostics.js";
import { isDisplayMode, isTargetLanguage } from "../shared/languages.js";
import { DISPLAY_STORAGE_KEY, readDisplayMode } from "./display-settings.js";
import { FloatingControls } from "./page/FloatingControls.js";
import { FLOATING_ENABLED_KEY, FLOATING_POSITION_KEY, floatingEnabled, floatingPosition } from "./floating-settings.js";
import {
  DEFAULT_TRANSLATION_STYLE,
  normalizeTranslationStyle,
  STYLE_STORAGE_KEY,
  translationStyleCss,
} from "./translation-style.js";

const contentGlobal = globalThis as typeof globalThis & { __folioInstalled?: boolean };

if (!contentGlobal.__folioInstalled) {
  contentGlobal.__folioInstalled = true;

  let contextInvalidated = false;
  const runtimeAvailable = (): boolean => {
    if (contextInvalidated) return false;
    try {
      if (chrome.runtime.id) return true;
    } catch { /* Reloaded extensions may also throw when reading runtime.id. */ }
    invalidateContext();
    return false;
  };
  const handleRuntimeError = (error: unknown) => {
    if (/extension context invalidated/i.test(String(error))) invalidateContext();
    else runtimeAvailable();
  };
  const sendRuntime = async <T>(request: ExtensionRequest): Promise<Result<T>> => {
    if (runtimeAvailable()) {
      try {
        // sendMessage can throw before returning a Promise after an extension
        // reload. Keep the call itself inside the try, including abort callbacks.
        const response = await chrome.runtime.sendMessage(request) as Result<T>;
        if (runtimeAvailable()) return response;
      } catch (error) {
        handleRuntimeError(error);
      }
    }
    return { ok: false, error: { code: "HOST_UNAVAILABLE", message: contextInvalidated
      ? "扩展已更新或重新加载，请刷新网页后继续翻译。"
      : "扩展连接中断，请重试。" } };
  };

  let appearance = DEFAULT_TRANSLATION_STYLE;
  let floating: FloatingControls | undefined;
  let floatingEnabledRevision = 0;
  let floatingPositionRevision = 0;
  let appearanceRevision = 0;
  let appearanceStyle: HTMLStyleElement | null = null;
  const applyAppearance = () => {
    if (contextInvalidated) return;
    if (!appearanceStyle?.isConnected) {
      appearanceStyle = document.querySelector<HTMLStyleElement>("style[data-folio-style]");
      if (!appearanceStyle) {
        appearanceStyle = document.createElement("style");
        appearanceStyle.setAttribute("data-folio-style", "");
        (document.head ?? document.documentElement).append(appearanceStyle);
      }
    }
    const css = translationStyleCss(appearance);
    if (appearanceStyle.textContent !== css) appearanceStyle.textContent = css;
  };
  const loadAppearance = async () => {
    if (!runtimeAvailable()) return;
    const revision = ++appearanceRevision;
    try {
      const stored = await chrome.storage.local.get(STYLE_STORAGE_KEY);
      // A storage change or newer read always wins over a late initial read.
      if (!runtimeAvailable() || revision !== appearanceRevision) return;
      appearance = normalizeTranslationStyle(stored[STYLE_STORAGE_KEY]);
      applyAppearance();
    } catch (error) {
      // Keep the default, or the latest already-applied appearance, offline.
      handleRuntimeError(error);
    }
  };
  const onAppearanceChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (!runtimeAvailable()) return;
    if (areaName !== "local") return;
    if (Object.hasOwn(changes, STYLE_STORAGE_KEY)) {
      appearanceRevision += 1;
      appearance = normalizeTranslationStyle(changes[STYLE_STORAGE_KEY]?.newValue);
      applyAppearance();
    }
    if (Object.hasOwn(changes, DISPLAY_STORAGE_KEY)) {
      displayRevision += 1;
      const mode = changes[DISPLAY_STORAGE_KEY]?.newValue;
      hasLocalDisplayMode = isDisplayMode(mode);
      translator.setDisplayMode(isDisplayMode(mode) ? mode : "bilingual");
    }
    if (Object.hasOwn(changes, FLOATING_ENABLED_KEY)) {
      floatingEnabledRevision += 1;
      floating?.setEnabled(floatingEnabled(changes[FLOATING_ENABLED_KEY]?.newValue));
    }
    if (Object.hasOwn(changes, FLOATING_POSITION_KEY)) {
      floatingPositionRevision += 1;
      floating?.setPosition(floatingPosition(changes[FLOATING_POSITION_KEY]?.newValue));
    }
  };
  // Some SPAs replace their head as well as their body. Checking connectivity
  // keeps this observer constant-time; ordinary content changes do no work.
  const appearanceObserver = new MutationObserver(() => {
    if (runtimeAvailable() && !appearanceStyle?.isConnected) applyAppearance();
  });

  let batchSequence = 0;
  let continuing = false;
  let explicitlyStopped = false;
  let observedUrl = location.href;
  let navigationId = 0;
  let click: { jobId: string; at: number; before: Map<Element, string | null> } | undefined;
  const timings = new TimingLog("page");
  const markFirstVisible = () => {
    if (!click || !runtimeAvailable()) return;
    const visible = Array.from(document.querySelectorAll<HTMLElement>('[data-folio="translation"]')).some((node) => {
      const bounds = node.getBoundingClientRect();
      return Boolean(node.textContent?.trim()) && click!.before.get(node) !== node.textContent &&
        bounds.width > 0 && bounds.height > 0 && bounds.top < innerHeight && bounds.bottom > 0;
    });
    if (!visible) return;
    const elapsed = Date.now() - click.at;
    timings.mark("ui.firstVisible", { jobId: click.jobId }, { clickToVisibleMs: elapsed, clockValid: elapsed >= 0 });
    click = undefined;
  };
  const progressListeners = new Map<string, {
    jobId: string;
    update?: (translations: Translation[]) => void;
  }>();
  const transport: TranslationTransport = {
    async translate(jobId, settingsRevision, blocks, options) {
      if (options?.signal?.aborted) {
        return { ok: false, error: { code: "CANCELLED", message: "翻译已停止。" } };
      }
      const batchId = `batch-${++batchSequence}`;
      const identity = { jobId, batchId };
      timings.mark("batch.send", identity, { blocks: blocks.length });
      progressListeners.set(batchId, { jobId, update: options?.onProgress });
      const cancel = () => {
        timings.mark("batch.cancel", identity);
        progressListeners.delete(batchId);
        void sendRuntime({
          type: "translate.cancelBatch", jobId, batchId,
        });
      };
      options?.signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await sendRuntime<Translation[]>({
          type: "translate.batch", jobId, batchId, settingsRevision, blocks,
        });
      } finally {
        timings.mark("batch.reply", identity);
        options?.signal?.removeEventListener("abort", cancel);
        progressListeners.delete(batchId);
      }
    },
    async cancel(jobId) {
      await sendRuntime({ type: "translate.cancel", jobId });
    },
  };

  const translator = new PageTranslator(document, transport, { onStateChange: (state) => floating?.update(state) });
  floating = new FloatingControls(document, {
    iconUrl: chrome.runtime.getURL("icons/icon-32.png"),
    action: async (action) => {
      const result = await sendRuntime<PageState>({ type: "page.control", action, clickedAtEpochMs: Date.now() });
      // The translator publishes live state; a delayed command acknowledgement
      // must not replace newer progress with its earlier snapshot.
      if (!result.ok) return result;
    },
    savePosition: async (position) => {
      if (runtimeAvailable()) await chrome.storage.local.set({ [FLOATING_POSITION_KEY]: position });
    },
  });
  floating.update(translator.getState());
  floating.setEnabled(false);
  const loadFloatingSettings = async () => {
    const enabledRevision = ++floatingEnabledRevision;
    const positionRevision = ++floatingPositionRevision;
    try {
      const stored = await chrome.storage.local.get([FLOATING_ENABLED_KEY, FLOATING_POSITION_KEY]);
      if (!runtimeAvailable()) return;
      // Position changes in another tab must not discard the enable preference,
      // and a toggle must not discard a separately saved position.
      if (positionRevision === floatingPositionRevision) floating?.setPosition(floatingPosition(stored[FLOATING_POSITION_KEY]));
      if (enabledRevision === floatingEnabledRevision) floating?.setEnabled(floatingEnabled(stored[FLOATING_ENABLED_KEY]));
    } catch (error) { handleRuntimeError(error); }
  };
  let displayRevision = 0;
  let hasLocalDisplayMode = false;
  const loadDisplayMode = async () => {
    const revision = ++displayRevision;
    try {
      const mode = await readDisplayMode();
      if (!runtimeAvailable() || revision !== displayRevision) return;
      const hadLocalDisplayMode = hasLocalDisplayMode;
      hasLocalDisplayMode = mode !== undefined;
      // Missing storage keeps the last command's legacy fallback until migration.
      // A removed local preference, including during BFcache, restores the default.
      if (mode || hadLocalDisplayMode) {
        translator.setDisplayMode(mode ?? "bilingual");
      }
    } catch (error) { handleRuntimeError(error); }
  };
  const visibleObserver = new MutationObserver(markFirstVisible);

  const checkNavigation = () => {
    if (!runtimeAvailable()) return;
    const url = location.href;
    if (url === observedUrl) return;
    observedUrl = url;
    if (!continuing) return;
    // End the old DOM lifetime before asking the background for a new identity.
    // The background owns continuation authority; the page never invents jobs.
    translator.handle("restore");
    click = undefined;
    void sendRuntime({ type: "page.navigate", url, navigationId: ++navigationId });
  };
  // Isolated-world history patches cannot observe main-world pushState. A small
  // URL-only poll covers it without requesting webNavigation or reading text.
  let navigationPoll: number | undefined;
  const onPageHide = () => {
    if (!runtimeAvailable()) return;
    continuing = false;
    click = undefined;
    if (!["idle", "stopped"].includes(translator.getState().status)) translator.handle("stop");
    window.clearInterval(navigationPoll);
    visibleObserver.disconnect();
    appearanceObserver.disconnect();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted || !runtimeAvailable()) return;
    continuing = false;
    observedUrl = location.href;
    window.clearInterval(navigationPoll);
    navigationPoll = window.setInterval(checkNavigation, 250);
    visibleObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    appearanceObserver.observe(document.documentElement, { childList: true, subtree: true });
    applyAppearance();
    void loadAppearance();
    void loadDisplayMode();
    void loadFloatingSettings();
    if (!explicitlyStopped) {
      void sendRuntime({ type: "page.ready", restored: true });
    }
  };

  const onMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    if (!runtimeAvailable() || sender.id !== chrome.runtime.id) return false;
    if ((message as { type?: string }).type === "page.diagnostics") {
      sendResponse([...translator.getDiagnostics(), ...timings.read()]);
      return false;
    }
    const progress = message as Partial<PageProgress>;
    if (progress.type === "translate.progress" && progress.batchId) {
      const listener = progressListeners.get(progress.batchId);
      if (listener && listener.jobId === progress.jobId && Array.isArray(progress.translations)) {
        listener.update?.(progress.translations);
        markFirstVisible();
      }
      sendResponse({});
      return false;
    }
    const command = message as Partial<PageCommand> & { url?: string };
    if (command.type !== "page.command" || !command.action) return false;

    if (["start", "retry", "retranslate"].includes(command.action)) {
      if (!command.jobId || !command.settingsRevision) {
        sendResponse({ ok: false, error: { code: "INVALID_REQUEST", message: "后台没有提供有效的翻译任务。" } });
        return false;
      }
      if (command.url && command.url !== location.href) {
        sendResponse({ ok: false, error: { code: "CANCELLED", message: "网页地址已变化。" } });
        return false;
      }
      continuing = true;
      explicitlyStopped = false;
      observedUrl = location.href;
      if (isTargetLanguage(command.targetLanguage)) translator.setTargetLanguage(command.targetLanguage);
      if (!hasLocalDisplayMode && isDisplayMode(command.displayMode)) {
        translator.setDisplayMode(command.displayMode);
      }
      click = command.jobId && command.clickedAtEpochMs ? {
        jobId: command.jobId, at: command.clickedAtEpochMs,
        before: new Map(Array.from(document.querySelectorAll('[data-folio="translation"]'), (node) => [node, node.textContent])),
      } : undefined;
      if (click) timings.mark("ui.commandReceived", { jobId: click.jobId }, {
        clickToCommandMs: Date.now() - click.at,
        clockValid: Date.now() >= click.at,
      });
    } else if (command.action === "stop" || command.action === "restore") {
      continuing = false;
      explicitlyStopped = true;
      click = undefined;
    }

    // The page replies immediately; translation continues independently of the popup.
    const state = translator.handle(command.action, command.jobId, command.settingsRevision);
    sendResponse({ ok: true, result: state });
    return false;
  };

  function invalidateContext(): void {
    if (contextInvalidated) return;
    // Set this before stopping: abort handlers must not send on the dead runtime.
    contextInvalidated = true;
    continuing = false;
    explicitlyStopped = true;
    click = undefined;
    appearanceRevision += 1;
    displayRevision += 1;
    floatingEnabledRevision += 1;
    floatingPositionRevision += 1;
    window.clearInterval(navigationPoll);
    removeEventListener("popstate", checkNavigation);
    removeEventListener("hashchange", checkNavigation);
    removeEventListener("pagehide", onPageHide);
    removeEventListener("pageshow", onPageShow);
    visibleObserver.disconnect();
    appearanceObserver.disconnect();
    progressListeners.clear();
    translator.dispose();
    floating?.dispose();
    // Listener removal can itself throw once Chrome has invalidated the APIs.
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* Already detached. */ }
    try { chrome.storage.onChanged.removeListener(onAppearanceChanged); } catch { /* Already detached. */ }
  }

  if (runtimeAvailable()) {
    addEventListener("popstate", checkNavigation);
    addEventListener("hashchange", checkNavigation);
    addEventListener("pagehide", onPageHide);
    addEventListener("pageshow", onPageShow);
    navigationPoll = window.setInterval(checkNavigation, 250);
    visibleObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    appearanceObserver.observe(document.documentElement, { childList: true, subtree: true });
    try {
      chrome.runtime.onMessage.addListener(onMessage);
      chrome.storage.onChanged.addListener(onAppearanceChanged);
    } catch (error) { handleRuntimeError(error); }
    applyAppearance();
    void loadAppearance();
    void loadDisplayMode();
    void loadFloatingSettings();
    void sendRuntime({ type: "page.ready" });
  }
}
