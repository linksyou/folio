import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTranslationStyle, translationStyleCss } from "../src/extension/translation-style.js";

test("old appearance settings keep theme defaults and preserve valid custom colors independently", () => {
  assert.deepEqual(normalizeTranslationStyle(undefined), { preset: "plain", fontScale: 1, textColor: "#4a9834" });
  assert.deepEqual(normalizeTranslationStyle({ preset: "plain", fontScale: 1.25 }), { preset: "plain", fontScale: 1.25 });
  assert.deepEqual(normalizeTranslationStyle({ preset: "border", fontScale: 1, textColor: "#ABCDEF", backgroundColor: "invalid" }),
    { preset: "border", fontScale: 1, textColor: "#abcdef" });
});

test("stored color strings cannot inject arbitrary CSS or network requests", () => {
  const malicious = { preset: "background", fontScale: 1, textColor: "red; display:none", backgroundColor: "url(https://bad.test/track)" } as const;
  assert.deepEqual(normalizeTranslationStyle(malicious), { preset: "background", fontScale: 1 });
  const css = translationStyleCss(malicious);
  assert.doesNotMatch(css, /bad\.test|display:none|url\(/);
});
