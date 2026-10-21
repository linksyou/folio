import { isDisplayMode, type DisplayMode } from "../shared/languages.js";
import { DISPLAY_STORAGE_KEY, readDisplayMode, saveDisplayMode } from "./display-settings.js";

/** Changes remain usable when the native host is offline or saving credentials. */
export function initializeDisplaySettings(): { migrateLegacy: (legacy: unknown) => void } {
  const select = document.getElementById("display-mode") as HTMLSelectElement;
  const status = document.getElementById("display-mode-status") as HTMLParagraphElement;
  let revision = 0;
  let hasStored = false;
  let migrationStarted = false;
  let writes = Promise.resolve();
  const showStatus = (message: string, failed = false) => {
    status.textContent = message;
    status.classList.toggle("danger-text", failed);
  };
  const loaded = readDisplayMode().then((mode) => {
    if (revision) return;
    hasStored = mode !== undefined;
    select.value = mode ?? "bilingual";
    showStatus("");
  }).catch(() => {
    if (!revision) showStatus("暂时无法读取显示方式。修改后将重新保存。", true);
    // Unknown storage state must not be treated as a missing preference during migration.
    hasStored = true;
  });

  function write(mode: DisplayMode, version: number, migrate = false): void {
    writes = writes.then(async () => {
      // A migration or earlier selection queued behind another write may be stale.
      if (version !== revision) return;
      try {
        const saved = await saveDisplayMode(mode, migrate);
        if (version !== revision) return;
        hasStored = true;
        select.value = saved;
        showStatus("显示方式已保存");
      } catch {
        if (version === revision) showStatus("显示方式保存失败，尚未应用到网页。请重新选择后重试。", true);
      }
    });
  }

  select.addEventListener("change", () => {
    if (!isDisplayMode(select.value)) return;
    hasStored = true; // A delayed legacy status cannot replace this explicit choice.
    showStatus("正在保存显示方式…");
    write(select.value, ++revision);
  });

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !Object.hasOwn(changes, DISPLAY_STORAGE_KEY)) return;
    const mode = changes[DISPLAY_STORAGE_KEY]?.newValue;
    revision += 1;
    hasStored = isDisplayMode(mode);
    select.value = isDisplayMode(mode) ? mode : "bilingual";
    showStatus("显示方式已同步");
  });

  return {
    migrateLegacy(legacy: unknown): void {
      if (migrationStarted || !isDisplayMode(legacy)) return;
      migrationStarted = true;
      const version = revision;
      void loaded.then(async () => {
        if (hasStored || revision !== version) return;
        // Another settings page may have saved after the initial read.
        let existing: DisplayMode | undefined;
        try { existing = await readDisplayMode(); }
        catch { return; }
        if (hasStored || revision !== version) return;
        if (existing) { hasStored = true; select.value = existing; return; }
        select.value = legacy;
        write(legacy, revision, true);
      });
    },
  };
}
