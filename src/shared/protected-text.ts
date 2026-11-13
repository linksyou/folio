/** Reserved, opaque markers. Original protected text never leaves the page. */
// Bounded markers cannot themselves exceed a chunk (literal webpage text may
// contain arbitrarily long numbers). Ten digits exceed any practical DOM size.
export const PROTECTED_TOKEN = /⟪FOLIO:\d{1,10}⟫/gu;
export interface ProtectedText { token: string; text: string }

export function preservesProtectedText(source: string, translation: string, partial = false): boolean {
  const expected: string[] = Array.from(source.match(PROTECTED_TOKEN) ?? []);
  const actual: string[] = Array.from(translation.match(PROTECTED_TOKEN) ?? []);
  if (!partial && expected.length !== actual.length) return false;
  for (const token of actual) {
    const index = expected.indexOf(token);
    if (index === -1) return false;
    expected.splice(index, 1);
  }
  return true;
}

/** Withhold an unfinished marker during streaming; never render its internals. */
export function restoreProtectedText(text: string, protectedText: ProtectedText[], partial = false): string {
  if (partial) {
    const start = text.lastIndexOf("⟪");
    if (start !== -1 && !text.slice(start).includes("⟫")) text = text.slice(0, start);
  }
  const values = new Map(protectedText.map(item => [item.token, item.text]));
  return text.replace(PROTECTED_TOKEN, token => values.get(token) ?? token);
}
