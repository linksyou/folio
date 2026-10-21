import type {
  ExtensionRequest,
  HostCommand,
  HostStatus,
  Model,
  ReasoningChoice,
  Result,
  SaveSettings,
} from "../shared/protocol.js";
import {
  REASONING_CHOICES,
  REASONING_LABELS,
  normalizeReasoningChoice,
  reasoningChoicesForModel,
} from "../shared/reasoning.js";
import { LANGUAGES, isTargetLanguage } from "../shared/languages.js";
import { initializeTranslationStyle } from "./options-style.js";
import { initializeDisplaySettings } from "./options-display.js";
import { initializeTranslationCache } from "./options-cache.js";
import { initializeFloatingSettings } from "./floating-settings.js";

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

const errorBox = required<HTMLParagraphElement>("host-error");
const targetLanguage = required<HTMLSelectElement>("target-language");
const displaySettings = initializeDisplaySettings();
initializeFloatingSettings();
for (const [value, language] of Object.entries(LANGUAGES)) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = language.label;
  targetLanguage.append(option);
}
const hostHelp = required<HTMLDivElement>("host-help");
const hostControls = required<HTMLFieldSetElement>("host-controls");
const hostState = required<HTMLSpanElement>("host-state");
const retryHostButton = required<HTMLButtonElement>("retry-host");
const notice = required<HTMLParagraphElement>("notice");
const profileSelect = required<HTMLSelectElement>("profile");
const modelSelect = required<HTMLSelectElement>("chatgpt-model");
const modelStatus = required<HTMLParagraphElement>("model-status");
const refreshModelsButton = required<HTMLButtonElement>("refresh-models");
const chatgptReasoningSelect = required<HTMLSelectElement>("chatgpt-reasoning");
const customReasoningSelect = required<HTMLSelectElement>("custom-reasoning");
const authSummary = required<HTMLElement>("auth-summary");
const baseUrlInput = required<HTMLInputElement>("custom-base-url");
const apiKeyInput = required<HTMLInputElement>("api-key");
const customModelInput = required<HTMLInputElement>("custom-model");
const keySummary = required<HTMLSpanElement>("key-summary");
const cancelLoginButton = required<HTMLButtonElement>("cancel-login");
const loginButton = required<HTMLButtonElement>("login");
const loginNewButton = required<HTMLButtonElement>("login-new");
const logoutButton = required<HTMLButtonElement>("logout");
const testButton = required<HTMLButtonElement>("test");
const usageLink = required<HTMLAnchorElement>("usage-link");
const planBadge = required<HTMLSpanElement>("plan-badge");
const planWelcome = required<HTMLDialogElement>("plan-welcome");
const endpointPreview = required<HTMLElement>("custom-endpoint");

const modelCatalogs = new Map<string, Model[]>();
const latestModelRequest = new Map<string, number>();
let modelRequestSequence = 0;
let activeProfileKey = "signed-out";
let currentStatus: HostStatus | undefined;
let clearSavedKey = false;
let loginPending = false;
let loginAttempt = 0;
let planWelcomeChecking = false;
let planWelcomeAcknowledged = false;
let retryPending = false;
let mutationSequence = 0;
let activeMutation: { id: number; kind: "save" | "test" | "login" | "cancel" | "logout" | "profile" } | undefined;
let disabledBeforeMutation = new Map<HTMLInputElement | HTMLSelectElement | HTMLButtonElement, boolean>();

function chineseError(error: { code: string; message: string }): string {
  if (/[㐀-鿿]/u.test(error.message)) return error.message;
  const known: Record<string, string> = {
    HOST_UNAVAILABLE: "未检测到本地辅助程序，请按安装说明完成注册后重新检测。",
    LOGIN_CANCELLED: "登录已取消。",
    AUTH_REQUIRED: "请先登录 ChatGPT。",
    PLAN_DISABLED: "当前账号尚未允许使用 ChatGPT 计划。",
    INVALID_SETTINGS: "连接设置不完整，请检查后重试。",
  };
  return known[error.code] ?? `操作失败（${error.code}），请重试。`;
}

function showError(message = ""): void {
  errorBox.hidden = !message;
  errorBox.textContent = message;
}

function showNotice(message = ""): void {
  notice.hidden = !message;
  notice.textContent = message;
}

function setHostState(state: "connected" | "pending" | "offline", text: string): void {
  hostState.className = `connection-pill ${state}`;
  hostState.textContent = text;
}

function syncControlAvailability(): void {
  if (!currentStatus || activeMutation) return;
  const signedIn = currentStatus.auth.state === "signed_in";
  const canUsePlan = signedIn && currentStatus.auth.planEnabled;
  logoutButton.disabled = !signedIn;
  profileSelect.disabled = !signedIn || currentStatus.auth.profiles.length < 2;
  refreshModelsButton.disabled = !canUsePlan;
  modelSelect.disabled = !canUsePlan;
  chatgptReasoningSelect.disabled = !canUsePlan;
}

function setMutationControls(disabled: boolean, allowCancel = false): void {
  const controls = hostControls.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button");
  if (disabled) {
    disabledBeforeMutation = new Map([...controls].map((control) => [control, control.disabled]));
    for (const control of controls) control.disabled = allowCancel && control === cancelLoginButton ? false : true;
    hostControls.setAttribute("aria-busy", "true");
    return;
  }
  for (const [control, wasDisabled] of disabledBeforeMutation) control.disabled = wasDisabled;
  disabledBeforeMutation.clear();
  hostControls.removeAttribute("aria-busy");
  syncControlAvailability();
}

function beginMutation(kind: NonNullable<typeof activeMutation>["kind"], allowCancel = false): number | undefined {
  if (activeMutation) return undefined;
  const id = ++mutationSequence;
  activeMutation = { id, kind };
  setMutationControls(true, allowCancel);
  return id;
}

function finishMutation(id: number): void {
  if (activeMutation?.id !== id) return;
  activeMutation = undefined;
  setMutationControls(false);
}

function replaceLoginWithCancel(): number | undefined {
  if (activeMutation?.kind !== "login") return undefined;
  const id = ++mutationSequence;
  activeMutation = { id, kind: "cancel" };
  cancelLoginButton.disabled = true;
  return id;
}

function setSingleOption(select: HTMLSelectElement, label: string): void {
  select.replaceChildren(new Option(label, ""));
}

function setDisconnected(message: string, showInstallHelp = true): void {
  currentStatus = undefined;
  activeProfileKey = "signed-out";
  showNotice();
  loginAttempt += 1;
  loginPending = false;
  cancelLoginButton.hidden = true;
  hostControls.disabled = true;
  hostHelp.hidden = !showInstallHelp;
  authSummary.textContent = "本地辅助程序未连接";
  usageLink.hidden = true;
  planBadge.hidden = true;
  setHostState("offline", "本地程序未连接");
  if (planWelcome.open) planWelcome.close();
  setSingleOption(profileSelect, "等待本地程序");
  setSingleOption(modelSelect, "等待本地程序");
  setReasoningOptions(chatgptReasoningSelect, ["auto"], "auto");
  modelStatus.textContent = "连接本地辅助程序后读取模型。";
  showError(message);
}

function handleHostFailure(error: { code: string; message: string }): void {
  const message = chineseError(error);
  if (error.code === "HOST_UNAVAILABLE") setDisconnected(message);
  else showError(message);
}

function updateEndpointPreview(): void {
  const base = baseUrlInput.value.trim().replace(/\/+$/, "");
  endpointPreview.textContent = base ? `${base}/chat/completions` : "请先填写基础地址";
}

async function maybeShowPlanWelcome(status: HostStatus): Promise<void> {
  const eligible = status.auth.state === "signed_in" && status.auth.planEnabled;
  if (!eligible) {
    if (planWelcome.open) planWelcome.close();
    return;
  }
  if (planWelcomeAcknowledged || planWelcomeChecking || planWelcome.open) return;
  planWelcomeChecking = true;
  try {
    const stored = await chrome.storage.local.get("planUsageNoticeAcknowledged");
    planWelcomeAcknowledged = stored.planUsageNoticeAcknowledged === true;
    const latest = currentStatus;
    if (!planWelcomeAcknowledged && latest?.auth.state === "signed_in" && latest.auth.planEnabled) planWelcome.showModal();
  } finally {
    planWelcomeChecking = false;
  }
}

async function host<T>(command: HostCommand): Promise<Result<T>> {
  try {
    return (await chrome.runtime.sendMessage({ type: "host.request", command } satisfies ExtensionRequest)) as Result<T>;
  } catch {
    return { ok: false, error: { code: "HOST_UNAVAILABLE", message: "本地辅助程序不可用。" } };
  }
}

function statusProfileKey(status: HostStatus): string {
  if (status.auth.state !== "signed_in") return "signed-out";
  return status.auth.profile?.id ?? "signed-in-default";
}

function setOptions(select: HTMLSelectElement, values: Array<{ id: string; label: string }>, selected = "", empty = "暂无可选项"): void {
  select.replaceChildren();
  for (const value of values) select.append(new Option(value.label, value.id, false, value.id === selected));
  if (!values.length) select.append(new Option(empty, ""));
  select.value = values.some((value) => value.id === selected) ? selected : "";
}

function selectedModel(): Model | undefined {
  return modelCatalogs.get(activeProfileKey)?.find((model) => model.id === modelSelect.value);
}

function setReasoningOptions(select: HTMLSelectElement, choices: readonly ReasoningChoice[], selectedValue: unknown): void {
  const selected = normalizeReasoningChoice(selectedValue);
  const available = [...choices];
  if (!available.includes(selected)) available.push(selected);
  select.replaceChildren(...available.map((choice) => {
    const unsupportedSaved = !choices.includes(choice);
    const suffix = unsupportedSaved ? "（当前已保存，模型目录未声明支持）" : "";
    return new Option(`${REASONING_LABELS[choice]}${suffix}`, choice, false, choice === selected);
  }));
  select.value = selected;
}

function updateChatgptReasoning(selectedValue: unknown): void {
  setReasoningOptions(chatgptReasoningSelect, reasoningChoicesForModel(selectedModel()), selectedValue);
}

function renderModelCatalog(selected: string, preserveDomSelection = false, preserveReasoning = false): void {
  const catalog = modelCatalogs.get(activeProfileKey) ?? [];
  const wanted = preserveDomSelection && modelSelect.value ? modelSelect.value : selected;
  const options = catalog.map((model) => ({ id: model.id, label: model.name || model.id }));
  if (wanted && !catalog.some((model) => model.id === wanted)) options.unshift({ id: wanted, label: `${wanted}（当前选择）` });
  setOptions(modelSelect, options, wanted, currentStatus?.auth.state === "signed_in" ? "目录暂无模型" : "登录后选择模型");
  updateChatgptReasoning(preserveReasoning ? chatgptReasoningSelect.value : currentStatus?.settings.chatgptReasoningEffort);
}

function render(status: HostStatus): void {
  currentStatus = status;
  targetLanguage.value = status.settings.targetLanguage ?? "zh-CN";
  displaySettings.migrateLegacy(status.settings.displayMode);
  activeProfileKey = statusProfileKey(status);
  hostControls.disabled = false;
  hostHelp.hidden = true;
  setHostState("connected", "本地程序已连接");

  const provider = document.querySelector<HTMLInputElement>(`input[name='provider'][value='${status.settings.provider}']`);
  if (provider) provider.checked = true;
  required<HTMLElement>("chatgpt-section").hidden = status.settings.provider !== "chatgpt";
  required<HTMLElement>("custom-section").hidden = status.settings.provider !== "custom";

  const auth = status.auth;
  const signedIn = auth.state === "signed_in";
  const canUsePlan = signedIn && auth.planEnabled;
  authSummary.textContent = signedIn
    ? `${auth.profile?.label ?? "已登录"}${auth.planEnabled ? " · 计划可用" : " · 计划暂不可用"}`
    : "尚未登录 ChatGPT";
  usageLink.hidden = !canUsePlan;
  planBadge.hidden = !canUsePlan;
  loginButton.hidden = signedIn;
  loginNewButton.textContent = signedIn ? "登录其他账号" : "使用其他账号登录";
  setOptions(profileSelect, auth.profiles.map((profile) => ({ id: profile.id, label: profile.email ? `${profile.label} · ${profile.email}` : profile.label })), auth.profile?.id, signedIn ? "当前账号" : "尚未登录");

  baseUrlInput.value = status.settings.customBaseUrl;
  customModelInput.value = status.settings.customModel;
  setReasoningOptions(customReasoningSelect, REASONING_CHOICES, status.settings.customReasoningEffort);
  updateEndpointPreview();
  renderModelCatalog(status.settings.chatgptModel);
  modelStatus.textContent = canUsePlan
    ? modelCatalogs.has(activeProfileKey) ? `已读取 ${modelCatalogs.get(activeProfileKey)!.length} 个模型。` : "正在读取模型目录…"
    : signedIn ? "当前账号的 ChatGPT 计划暂不可用。" : "登录后读取可用模型。";

  clearSavedKey = false;
  apiKeyInput.value = "";
  apiKeyInput.placeholder = status.settings.hasApiKey ? "已保存；留空则保持不变" : "输入 API Key";
  keySummary.textContent = status.settings.hasApiKey ? "已保存 Key" : "未保存 Key";
  syncControlAvailability();
  void maybeShowPlanWelcome(status);
}

async function refreshStatus(): Promise<boolean> {
  showError();
  hostHelp.hidden = true;
  setHostState("pending", "正在连接");
  const response = await host<HostStatus>({ type: "status" });
  if (!response.ok) {
    setDisconnected(chineseError(response.error), response.error.code === "HOST_UNAVAILABLE");
    return false;
  }
  render(response.result);
  await refreshModels();
  return currentStatus !== undefined;
}

async function refreshModels(): Promise<void> {
  const status = currentStatus;
  if (!status || status.auth.state !== "signed_in" || !status.auth.planEnabled) return;
  const profileKey = activeProfileKey;
  const request = ++modelRequestSequence;
  latestModelRequest.set(profileKey, request);
  refreshModelsButton.disabled = true;
  modelStatus.textContent = modelCatalogs.has(profileKey) ? "正在更新模型目录…" : "正在读取模型目录…";
  const response = await host<Model[]>({ type: "models.list" });
  if (activeProfileKey !== profileKey || latestModelRequest.get(profileKey) !== request) return;
  if (!activeMutation) refreshModelsButton.disabled = false;
  if (!response.ok) {
    if (response.error.code === "HOST_UNAVAILABLE") handleHostFailure(response.error);
    else {
      modelStatus.textContent = modelCatalogs.has(profileKey) ? "刷新失败，继续使用上次读取的模型。" : "模型目录读取失败，请重试。";
      if (currentStatus?.settings.provider === "chatgpt") showError(chineseError(response.error));
    }
    renderModelCatalog(currentStatus?.settings.chatgptModel ?? "", true, true);
    return;
  }
  modelCatalogs.set(profileKey, response.result);
  renderModelCatalog(currentStatus?.settings.chatgptModel ?? "", true, true);
  modelStatus.textContent = response.result.length ? `已读取 ${response.result.length} 个模型。` : "账号未返回可用模型。";
}

function settingsSnapshot(): SaveSettings | undefined {
  if (!currentStatus) {
    setDisconnected("本地辅助程序未连接，请完成安装后重新检测。");
    return undefined;
  }
  const selectedProvider = document.querySelector<HTMLInputElement>("input[name='provider']:checked")?.value;
  if (selectedProvider !== "custom" && !modelSelect.value) {
    showError("请先登录并选择一个翻译模型。");
    return undefined;
  }
  const settings: SaveSettings = {
    targetLanguage: isTargetLanguage(targetLanguage.value) ? targetLanguage.value : "zh-CN",
    provider: selectedProvider === "custom" ? "custom" : "chatgpt",
    chatgptModel: modelSelect.value,
    chatgptReasoningEffort: normalizeReasoningChoice(chatgptReasoningSelect.value),
    customBaseUrl: baseUrlInput.value.trim(),
    customModel: customModelInput.value.trim(),
    customReasoningEffort: normalizeReasoningChoice(customReasoningSelect.value),
  };
  if (clearSavedKey) settings.apiKey = "";
  else if (apiKeyInput.value) settings.apiKey = apiKeyInput.value;
  return settings;
}

async function saveSnapshot(settings: SaveSettings): Promise<boolean> {
  const response = await host<HostStatus>({ type: "settings.save", settings });
  if (!response.ok) {
    handleHostFailure(response.error);
    return false;
  }
  render(response.result);
  showNotice("设置已保存。");
  return true;
}

async function save(): Promise<boolean> {
  const settings = settingsSnapshot();
  if (!settings) return false;
  const mutation = beginMutation("save");
  if (!mutation) return false;
  showError();
  showNotice();
  try {
    return await saveSnapshot(settings);
  } finally {
    finishMutation(mutation);
  }
}

async function login(newAccount: boolean): Promise<void> {
  const mutation = beginMutation("login", true);
  if (!mutation) return;
  const attempt = ++loginAttempt;
  loginPending = true;
  cancelLoginButton.hidden = false;
  showError();
  showNotice("请在新打开的页面中完成授权。你可以随时取消。");
  try {
    const response = await host<HostStatus>({ type: "auth.login", newAccount });
    if (attempt !== loginAttempt) return;
    loginPending = false;
    cancelLoginButton.hidden = true;
    if (!response.ok) {
      showNotice();
      handleHostFailure(response.error);
      return;
    }
    render(response.result);
    await refreshModels();
    if (currentStatus) showNotice("ChatGPT 登录已完成。");
  } finally {
    finishMutation(mutation);
  }
}

for (const radio of document.querySelectorAll<HTMLInputElement>("input[name='provider']")) {
  radio.addEventListener("change", () => {
    if (activeMutation) return;
    required<HTMLElement>("chatgpt-section").hidden = radio.value !== "chatgpt";
    required<HTMLElement>("custom-section").hidden = radio.value !== "custom";
  });
}
modelSelect.addEventListener("change", () => {
  if (activeMutation) return;
  updateChatgptReasoning("auto");
  modelStatus.textContent = "已切换模型；思考强度恢复为速度优先。";
});
required<HTMLButtonElement>("save").addEventListener("click", () => void save());
testButton.addEventListener("click", async () => {
  const settings = settingsSnapshot();
  if (!settings) return;
  const mutation = beginMutation("test");
  if (!mutation) return;
  showError();
  showNotice();
  try {
    if (!(await saveSnapshot(settings))) return;
    showNotice("正在执行一条短翻译测试…");
    const response = await host<{ text: string }>({ type: "connection.test" });
    if (!response.ok) { showNotice(); handleHostFailure(response.error); }
    else showNotice(`连接正常：${response.result.text}`);
  } finally {
    finishMutation(mutation);
  }
});
loginButton.addEventListener("click", () => void login(false));
loginNewButton.addEventListener("click", () => void login(true));
cancelLoginButton.addEventListener("click", async () => {
  const mutation = replaceLoginWithCancel();
  if (!mutation) return;
  loginAttempt += 1;
  loginPending = false;
  cancelLoginButton.hidden = true;
  try {
    const response = await host<unknown>({ type: "auth.cancel" });
    if (!response.ok) handleHostFailure(response.error);
    else { await refreshStatus(); showNotice("登录已取消。"); }
  } finally {
    finishMutation(mutation);
  }
});
logoutButton.addEventListener("click", async () => {
  const mutation = beginMutation("logout");
  if (!mutation) return;
  try {
    const response = await host<{ revoked: boolean }>({ type: "auth.logout" });
    if (!response.ok) handleHostFailure(response.error);
    else { await refreshStatus(); showNotice(response.result.revoked ? "已退出登录。" : "本地凭证已清除，远端撤销状态未确认。"); }
  } finally {
    finishMutation(mutation);
  }
});
profileSelect.addEventListener("change", async () => {
  const selected = profileSelect.value;
  const previous = currentStatus?.auth.profile?.id ?? "";
  if (!selected) return;
  const mutation = beginMutation("profile");
  if (!mutation) {
    profileSelect.value = previous;
    return;
  }
  try {
    const response = await host<HostStatus>({ type: "auth.select", profileId: selected });
    if (!response.ok) {
      profileSelect.value = previous;
      handleHostFailure(response.error);
    } else {
      render(response.result);
      await refreshModels();
    }
  } finally {
    finishMutation(mutation);
  }
});
refreshModelsButton.addEventListener("click", () => void refreshModels());
retryHostButton.addEventListener("click", async () => {
  if (retryPending) return;
  retryPending = true;
  retryHostButton.disabled = true;
  retryHostButton.textContent = "检测中…";
  showNotice("正在检测本地辅助程序…");
  try {
    if (await refreshStatus()) showNotice("本地辅助程序已连接。");
    else showNotice();
  } finally {
    retryPending = false;
    retryHostButton.disabled = false;
    retryHostButton.textContent = "重新检测";
  }
});
required<HTMLButtonElement>("ack-plan-welcome").addEventListener("click", async () => {
  planWelcomeAcknowledged = true;
  await chrome.storage.local.set({ planUsageNoticeAcknowledged: true });
  planWelcome.close();
});
required<HTMLButtonElement>("clear-key").addEventListener("click", () => {
  clearSavedKey = true;
  apiKeyInput.value = "";
  apiKeyInput.placeholder = "保存后删除已存 Key";
  keySummary.textContent = "将清除已保存的 Key";
});
apiKeyInput.addEventListener("input", () => {
  if (apiKeyInput.value) { clearSavedKey = false; keySummary.textContent = "将保存新 Key"; }
});
baseUrlInput.addEventListener("input", updateEndpointPreview);

initializeTranslationStyle();
initializeTranslationCache();
void refreshStatus();
