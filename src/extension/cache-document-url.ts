/** Strip only a confirmed DOM anchor and standard tracking parameters. Keep SPA routes and content query parameters. */
export function cacheDocumentUrl(value: string, anchorFragment = false): string {
  try {
    const url = new URL(value);
    if (anchorFragment && !/^#(?:!|\/)/u.test(url.hash)) url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_(?:source|medium|campaign|term|content|id)|gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return value; }
}
