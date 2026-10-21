import type { ConnectionPreparation, ExtensionRequest, HostStatus, PageAction, PageState, Result } from "../shared/protocol.js";
import type { SiteStatus } from "./site-rules.js";

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

const connectionSummary = required<HTMLParagraphElement>("connection-summary");
const connectionPreparation = required<HTMLParagraphElement>("connection-preparation");
const statusMessage = required<HTMLParagraphElement>("status-message");
const progressText = required<HTMLParagraphElement>("progress-text");
const progressBar = required<HTMLSpanElement>("progress-bar");
const errorBox = required<HTMLParagraphElement>("error");
const usageRow = required<HTMLParagraphElement>("usage-row");
const startButton = required<HTMLButtonElement>("start");
const stopButton = required<HTMLButtonElement>("stop");
const retryButton = required<HTMLButtonElement>("retry");
const restoreButton = required<HTMLButtonElement>("restore");
const autoTranslate = required<HTMLInputElement>("auto-translate");
const siteSummary = required<HTMLParagraphElement>("site-summary");
const siteHelp = required<HTMLParagraphElement>("site-help");
let currentSite: SiteStatus | undefined;
let sitePending = false;
let hostRevision = 0;
let preparationExpiry: ReturnType<typeof setTimeout> | undefined;
let currentPageState: PageState | undefined;
let pageRevision = 0;
let pollPending = false;
let actionPending = false;
const errors = { page: "", host: "", status: "", site: "" };

function chineseError(error: { code: string; message: string }): string {
  if (/[㐀-鿿]/u.test(error.message)) return error.message;
  const known: Record<string, string> = {
    HOST_UNAVAILABLE: "未检测到本地辅助程序，请打开设置查看安装说明。",
    PAGE_UNAVAILABLE: "当前页面暂不支持翻译。",
    AUTH_REQUIRED: "请先在设置中登录 ChatGPT。",
    PLAN_DISABLED: "当前账号尚未允许使用 ChatGPT 计划。",
    LIMIT_REACHED: "当前用量已达到限制，请稍后重试或更换连接。",
  };
  return known[error.code] ?? `操作失败（${error.code}），请重试。`;
}

function renderErrors(): void {
  const messages = Object.values(errors).filter(Boolean);
  errorBox.hidden = messages.length === 0;
  errorBox.textContent = messages.join(" ");
}

function setError(source: keyof typeof errors, message = ""): void {
  errors[source] = message;
  renderErrors();
}

async function send<T>(request: ExtensionRequest): Promise<Result<T>> {
  try {
    return (await chrome.runtime.sendMessage(request)) as Result<T>;
  } catch {
    return { ok: false, error: { code: "EXTENSION_ERROR", message: "扩展连接中断，请重试。" } };
  }
}

function renderPage(state: PageState): void {
  currentPageState = state;
  statusMessage.textContent = state.message;
  progressText.textContent = `${state.completed} / ${state.total} 段${state.skipped ? ` · 无需翻译 ${state.skipped} 段` : ""}${state.failed ? ` · 失败 ${state.failed} 段` : ""}`;
  const ratio = state.total ? Math.round(((state.completed + (state.skipped ?? 0)) / state.total) * 100) : 0;
  progressBar.style.width = `${ratio}%`;
  progressText.hidden = state.total === 0;
  progressBar.parentElement!.hidden = state.total === 0;
  const working = state.status === "running";
  // Completed pages still observe dynamic content and same-origin navigation.
  const stoppable = working || state.status === "watching" || state.status === "completed";
  stopButton.parentElement!.hidden = !stoppable && state.total === 0;
  stopButton.disabled = !stoppable || actionPending;
  retryButton.hidden = state.failed === 0;
  retryButton.disabled = state.failed === 0 || working || actionPending;
  restoreButton.disabled = state.total === 0 || actionPending;
  startButton.disabled = working || actionPending;
  startButton.textContent = working ? "正在翻译…" : state.status === "paused" || state.status === "stopped"
    ? "继续翻译"
    : state.status === "completed" || state.status === "watching"
      ? "重新翻译"
      : "翻译正文";
  startButton.title = state.status === "completed" || state.status === "watching"
    ? "忽略已有缓存，重新生成当前正文译文" : "";
}

async function pageAction(action: PageAction, userInitiated = true): Promise<void> {
  if (userInitiated && actionPending) return;
  if (!userInitiated && (pollPending || actionPending)) return;
  const revision = userInitiated ? ++pageRevision : pageRevision;
  if (userInitiated) {
    actionPending = true;
    if (currentPageState) renderPage(currentPageState);
  } else pollPending = true;
  const errorSource = userInitiated ? "page" : "status";
  if (userInitiated) setError("page");
  try {
    const response = await send<PageState>({ type: "page.action", action,
      ...(userInitiated && ["start", "retry", "retranslate"].includes(action) ? { clickedAtEpochMs: Date.now() } : {}),
    });
    if (revision !== pageRevision) return;
    if (!response.ok) {
      setError(errorSource, chineseError(response.error));
      return;
    }
    setError(errorSource);
    renderPage(response.result);
  } finally {
    if (userInitiated) {
      actionPending = false;
      if (currentPageState) renderPage(currentPageState);
    } else pollPending = false;
  }
}

async function loadHost(): Promise<void> {
  const revision = ++hostRevision;
  clearTimeout(preparationExpiry);
  connectionPreparation.hidden = true;
  const response = await send<HostStatus>({ type: "host.request", command: { type: "status" } });
  if (revision !== hostRevision) return;
  if (!response.ok) {
    connectionSummary.textContent = "本地连接不可用";
    usageRow.hidden = true;
    setError("host", chineseError(response.error));
    return;
  }
  setError("host");
  const { settings, auth } = response.result;
  if (settings.provider === "custom") {
    connectionSummary.textContent = `自定义 API · ${settings.customModel || "未选择模型"}`;
  } else {
    const account = auth.profile?.label ?? "未登录";
    connectionSummary.textContent = `ChatGPT · ${account} · ${settings.chatgptModel || "未选择模型"}`;
  }
  usageRow.hidden = !(
    settings.provider === "chatgpt" && auth.state === "signed_in" && auth.planEnabled
  );
  const configured = settings.provider === "custom"
    ? Boolean(settings.customBaseUrl && settings.customModel)
    : Boolean(settings.chatgptModel && auth.state === "signed_in" && auth.planEnabled);
  if (configured) void prepareConnection(revision);
}

async function prepareConnection(revision: number): Promise<void> {
  connectionPreparation.hidden = false;
  connectionPreparation.textContent = "正在准备连接…";
  const response = await send<ConnectionPreparation>({
    type: "host.request", command: { type: "connection.prepare" },
  });
  if (revision !== hostRevision) return;
  connectionPreparation.textContent = response.ok && response.result.ready
    ? "连接已就绪"
    : "点击翻译时连接";
  if (response.ok && response.result.ready) {
    preparationExpiry = setTimeout(() => { connectionPreparation.textContent = "翻译时自动重连"; }, 55_000);
  }
}

function renderSite(site: SiteStatus): void {
  currentSite = site;
  autoTranslate.checked = site.enabled;
  autoTranslate.disabled = sitePending || !site.supported;
  siteSummary.textContent = site.origin ?? "当前页面不可用";
  siteHelp.textContent = !site.supported
    ? "仅支持 HTTP/HTTPS 网页。"
    : site.enabled
      ? "新页与刷新自动翻译；停止仅影响当前页。关闭即撤销权限。"
      : site.permission
        ? "自动翻译已关闭；Chrome 仍报告此网站访问权限，可在扩展的网站访问权限中检查或撤销。"
        : "授权后新页与刷新自动翻译，关闭即撤销权限。";
}

async function loadSite(): Promise<void> {
  const response = await send<SiteStatus>({ type: "site.status" });
  if (!response.ok) { setError("site", chineseError(response.error)); return; }
  setError("site");
  renderSite(response.result);
}

autoTranslate.addEventListener("change", () => {
  const site = currentSite;
  if (!site?.origin || !site.pattern || sitePending) return;
  const enabled = autoTranslate.checked;
  sitePending = true;
  autoTranslate.disabled = true;
  setError("site");
  // Request directly in the user gesture, before any background round trip.
  const permission = enabled ? chrome.permissions.request({ origins: [site.pattern] }) : Promise.resolve(true);
  void permission.then(async (granted) => {
    if (!granted) {
      setError("site", "未获得此网站访问权限，自动翻译保持关闭。仍可手动翻译当前页。");
      renderSite(site);
      return;
    }
    const response = await send<SiteStatus>({ type: "site.set", origin: site.origin!, enabled });
    if (!response.ok) {
      setError("site", chineseError(response.error));
      const latest = await send<SiteStatus>({ type: "site.status" });
      renderSite(latest.ok ? latest.result : site);
      return;
    }
    renderSite(response.result);
    await pageAction(enabled ? "start" : "status", enabled);
  }).catch(() => {
    setError("site", "无法更新网站访问权限，请重新打开扩展后重试。");
    renderSite(site);
  }).finally(() => {
    sitePending = false;
    if (currentSite) renderSite(currentSite);
  });
});

startButton.addEventListener("click", () => {
  const status = currentPageState?.status;
  const action: PageAction = status === "paused" || status === "stopped"
    ? "retry"
    : status === "completed" || status === "watching"
      ? "retranslate"
      : "start";
  void pageAction(action);
});
stopButton.addEventListener("click", () => void pageAction("stop"));
retryButton.addEventListener("click", () => void pageAction("retry"));
restoreButton.addEventListener("click", () => void pageAction("restore"));
required<HTMLButtonElement>("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
required<HTMLButtonElement>("export-diagnostics").addEventListener("click", () => {
  void send<unknown>({ type: "diagnostics.get" }).then((response) => {
    if (!response.ok) { setError("host", chineseError(response.error)); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(response.result, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "open-web-translator-performance.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
});

void Promise.all([pageAction("status", false), loadHost(), loadSite()]);
const poll = window.setInterval(() => void pageAction("status", false), 750);
window.addEventListener("focus", () => { void Promise.all([loadHost(), loadSite()]); });
window.addEventListener("unload", () => { window.clearInterval(poll); clearTimeout(preparationExpiry); });
