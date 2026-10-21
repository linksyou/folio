import { isDisplayMode, type DisplayMode } from "../shared/languages.js";

/** Browser-local presentation; never a prompt or a translation cache input. */
export const DISPLAY_STORAGE_KEY = "translationDisplayMode";

export async function readDisplayMode(): Promise<DisplayMode | undefined> {
  const stored = await chrome.storage.local.get(DISPLAY_STORAGE_KEY);
  return isDisplayMode(stored[DISPLAY_STORAGE_KEY]) ? stored[DISPLAY_STORAGE_KEY] : undefined;
}

/** All settings pages share the extension origin, so migration cannot race a user write. */
export async function saveDisplayMode(mode: DisplayMode, onlyIfMissing = false): Promise<DisplayMode> {
  const write = async () => {
    if (onlyIfMissing) {
      const stored = await readDisplayMode();
      if (stored) return stored;
    }
    await chrome.storage.local.set({ [DISPLAY_STORAGE_KEY]: mode });
    return mode;
  };
  return globalThis.navigator?.locks
    ? navigator.locks.request("open-web-translator-display-settings", write)
    : write();
}

export async function resolveDisplayMode(legacy?: unknown): Promise<DisplayMode> {
  try {
    const stored = await readDisplayMode();
    if (stored) return stored;
  } catch { /* Local presentation must not prevent a translation from starting. */ }
  return isDisplayMode(legacy) ? legacy : "bilingual";
}
