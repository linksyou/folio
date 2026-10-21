import type { ExtensionRequest, Result } from "../shared/protocol.js";
import type { CacheStatus } from "./cache-settings.js";

/** Cache preferences belong to the browser, independently of model connectivity. */
export function initializeTranslationCache(): void {
  const enabled = document.querySelector<HTMLInputElement>("#cache-enabled");
  const origins = document.querySelector<HTMLSelectElement>("#cache-origin");
  const summary = document.querySelector<HTMLElement>("#cache-summary");
  const status = document.querySelector<HTMLElement>("#cache-status");
  const clearSite = document.querySelector<HTMLButtonElement>("#cache-clear-site");
  const clearAll = document.querySelector<HTMLButtonElement>("#cache-clear-all");
  if (!enabled || !origins || !summary || !status || !clearSite || !clearAll) return;
  let busy = false;
  const controls = () => {
    enabled.disabled = busy;
    origins.disabled = busy || !origins.options.length;
    clearSite.disabled = busy || !origins.value;
    clearAll.disabled = busy;
  };
  const request = async (message: ExtensionRequest, success = "") => {
    if (busy) return;
    busy = true;
    controls();
    try {
      const reply: Result<CacheStatus> = await chrome.runtime.sendMessage(message);
      if (!reply?.ok) throw new Error(reply?.error.message ?? "无法读取翻译缓存。");
      const value = reply.result;
      enabled.checked = value.enabled;
      if (value.available === false) {
        summary.textContent = "缓存暂时无法读取，记录数量未知。";
        status.textContent = `${success ? `${success} ` : ""}翻译仍可正常进行；请重新加载扩展后读取或清除缓存。`;
        return;
      }
      const selected = origins.value;
      origins.replaceChildren(...value.origins.map((origin) => {
        const option = document.createElement("option");
        option.value = origin;
        option.textContent = origin;
        return option;
      }));
      if (value.origins.includes(selected)) origins.value = selected;
      summary.textContent = `${value.entries} 条译文 · 约 ${(value.bytes / 1024).toFixed(1)} KiB · ${value.origins.length} 个网站`;
      status.textContent = success;
    } catch (error) {
      if (message.type === "cache.set") enabled.checked = !message.enabled;
      status.textContent = error instanceof Error ? error.message : "缓存操作失败，请重试。";
    } finally { busy = false; controls(); }
  };
  enabled.addEventListener("change", () => { void request({ type: "cache.set", enabled: enabled.checked }, enabled.checked ? "已启用缓存。" : "已停用缓存。已有记录可用下方按钮清除。"); });
  origins.addEventListener("change", controls);
  clearSite.addEventListener("click", () => { void request({ type: "cache.clear", origin: origins.value }, "已清除此网站的缓存；页面上的译文会保留。"); });
  clearAll.addEventListener("click", () => { void request({ type: "cache.clear" }, "已清除全部缓存；页面上的译文会保留。"); });
  void request({ type: "cache.status" });
}
