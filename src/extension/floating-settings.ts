import type { FloatingPosition } from "./page/FloatingControls.js";

export const FLOATING_ENABLED_KEY = "floatingControlsEnabled";
export const FLOATING_POSITION_KEY = "floatingControlsPosition";
export const floatingEnabled = (value: unknown): boolean => value !== false;

export function floatingPosition(value: unknown): FloatingPosition {
  const position = value as Partial<FloatingPosition> | null;
  return {
    edge: position?.edge === "left" ? "left" : "right",
    ratio: typeof position?.ratio === "number" && Number.isFinite(position.ratio)
      ? Math.max(0, Math.min(1, position.ratio)) : 0.55,
  };
}

/** Independent of native connection settings and model requests. */
export function initializeFloatingSettings(): void {
  const input = document.getElementById("floating-enabled") as HTMLInputElement | null;
  const status = document.getElementById("floating-status");
  if (!input || !status) return;
  let revision = 0;
  let writes = Promise.resolve();
  const show = (message: string, failed = false) => {
    status.textContent = message;
    status.classList.toggle("danger-text", failed);
  };
  void chrome.storage.local.get(FLOATING_ENABLED_KEY).then((stored) => {
    if (!revision) {
      input.checked = floatingEnabled(stored[FLOATING_ENABLED_KEY]);
      show("");
    }
  }).catch(() => {
    if (!revision) show("暂时无法读取悬浮工具设置，请重新选择后保存。", true);
  }).finally(() => { input.disabled = false; });
  input.addEventListener("change", () => {
    const version = ++revision;
    const enabled = input.checked;
    show("正在保存…");
    writes = writes.then(async () => {
      if (version !== revision) return;
      try {
        await chrome.storage.local.set({ [FLOATING_ENABLED_KEY]: enabled });
        if (version === revision) show(enabled ? "已开启，立即应用到已授权网页。" : "已关闭网页悬浮工具。");
      } catch {
        if (version === revision) show("保存失败，尚未应用。请重新选择后重试。", true);
      }
    });
  });
}
