export const CACHE_ENABLED_KEY = "translationCacheEnabled";

export interface CacheStatus {
  available?: boolean;
  enabled: boolean;
  entries: number;
  bytes: number;
  origins: string[];
}

export async function cacheEnabled(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(CACHE_ENABLED_KEY);
    return stored[CACHE_ENABLED_KEY] !== false;
  } catch {
    // A failed preference read must not silently opt a disabled user into storage.
    return false;
  }
}
