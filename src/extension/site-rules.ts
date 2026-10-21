import { AppError } from "../shared/errors.js";

const KEY = "autoTranslateOrigins";
const PREFIX = "owt-site-";
let updates: Promise<unknown> = Promise.resolve();

export interface SiteStatus {
  supported: boolean;
  origin?: string;
  pattern?: string;
  enabled: boolean;
  permission: boolean;
}

export function siteForUrl(value?: string): { origin: string; pattern: string } | undefined {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    // Explicit default ports keep the permission as narrow as the origin rule.
    return { origin: url.origin, pattern: `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}/*` };
  } catch { return; }
}

async function origins(): Promise<string[]> {
  const value: unknown = (await chrome.storage.local.get(KEY))[KEY];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && siteForUrl(item)?.origin === item) : [];
}

async function scriptId(origin: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(origin));
  return PREFIX + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function siteStatus(url?: string): Promise<SiteStatus> {
  const site = siteForUrl(url);
  if (!site) return { supported: false, enabled: false, permission: false };
  const [rules, permission] = await Promise.all([origins(), chrome.permissions.contains({ origins: [site.pattern] })]);
  return { supported: true, ...site, enabled: rules.includes(site.origin) && permission, permission };
}

async function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const current = updates.catch(() => undefined).then(operation);
  updates = current;
  return current;
}

export async function setSiteRule(origin: string, enabled: boolean): Promise<SiteStatus> {
  const site = siteForUrl(origin);
  if (!site || site.origin !== origin) throw new AppError("INVALID_REQUEST", "网站地址无效。");
  return serialize(async () => {
    const rules = await origins();
    const id = await scriptId(origin);
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (enabled) {
      if (!await chrome.permissions.contains({ origins: [site.pattern] })) {
        throw new AppError("PERMISSION_REQUIRED", "尚未获得此网站的访问权限，请重新启用自动翻译并允许访问。");
      }
      if (!registered.length) await chrome.scripting.registerContentScripts([{
        id, matches: [site.pattern], js: ["content.js"], runAt: "document_idle",
        allFrames: false, persistAcrossSessions: true,
      }]);
      try {
        await chrome.storage.local.set({ [KEY]: [...new Set([...rules, origin])].sort() });
      } catch (error) {
        if (!registered.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
        throw error;
      }
    } else {
      // Remove the authority first; an already injected script can no longer start.
      await chrome.storage.local.set({ [KEY]: rules.filter((item) => item !== origin) });
      let cleanupFailed = false;
      try {
        if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [id] });
      } catch { cleanupFailed = true; }
      try {
        const removed = await chrome.permissions.remove({ origins: [site.pattern] });
        if (!removed && await chrome.permissions.contains({ origins: [site.pattern] })) throw new Error("Permission remains");
      } catch {
        throw new AppError("PERMISSION_REMOVE_FAILED", "自动翻译已关闭，但 Chrome 未能撤销此网站访问权限。请在扩展的网站访问权限中检查。");
      }
      if (cleanupFailed) throw new AppError("SITE_CLEANUP_FAILED", "自动翻译已关闭，但浏览器未完成清理。请重新打开扩展后重试。");
    }
    return siteStatus(origin);
  });
}

/** Chrome persists registrations; reconcile rules after outside revocation/startup. */
export async function reconcileSiteRules(): Promise<string[]> {
  return serialize(async () => {
    const rules = await origins();
    const retained: string[] = [];
    const removed: string[] = [];
    const registrations = await chrome.scripting.getRegisteredContentScripts();
    const expected = new Set<string>();
    for (const origin of rules) {
      const site = siteForUrl(origin)!;
      if (!await chrome.permissions.contains({ origins: [site.pattern] })) { removed.push(origin); continue; }
      retained.push(origin);
      const id = await scriptId(origin);
      expected.add(id);
      if (!registrations.some((item) => item.id === id)) await chrome.scripting.registerContentScripts([{
        id, matches: [site.pattern], js: ["content.js"], runAt: "document_idle", allFrames: false, persistAcrossSessions: true,
      }]);
    }
    const stale = registrations.filter((item) => item.id.startsWith(PREFIX) && !expected.has(item.id)).map((item) => item.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
    if (removed.length) await chrome.storage.local.set({ [KEY]: retained });
    return removed;
  });
}
