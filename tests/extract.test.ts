import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { canHideRange, collectRanges, rangeStillMatches } from "../src/extension/page/extract.js";
import { extractionCases } from "./fixtures/extraction.js";

for (const fixture of extractionCases) {
  test(`extraction: ${fixture.name}`, () => {
    const dom = new JSDOM(`<!doctype html><html><body>${fixture.html}</body></html>`, { pretendToBeVisual: true });
    try {
      assert.deepEqual(collectRanges(dom.window.document).map((range) => range.source), fixture.expected);
    } finally { dom.window.close(); }
  });
}

test("changed text invalidates the original source range and is rediscovered", () => {
  const dom = new JSDOM("<main><section>Original article sentence with enough readable prose.</section></main>");
  try {
    const document = dom.window.document;
    const original = collectRanges(document)[0];
    original.nodes[0].textContent = "Updated article sentence with enough readable prose.";
    assert.equal(rangeStillMatches(original), false);
    assert.deepEqual(collectRanges(document).map((range) => range.source), ["Updated article sentence with enough readable prose."]);
  } finally { dom.window.close(); }
});

test("generated translations preserve source node identity and safe hiding", () => {
  const dom = new JSDOM("<section>This source is a long enough independent sentence.</section>");
  try {
    const document = dom.window.document;
    const source = collectRanges(document)[0];
    const translation = document.createElement("span");
    translation.dataset.folio = "translation";
    translation.textContent = "Generated translation.";
    source.element.append(translation);
    assert.equal(rangeStillMatches(source), true);
    assert.equal(canHideRange(source), true);
    assert.deepEqual(collectRanges(document).map((range) => range.source), [source.source]);
  } finally { dom.window.close(); }
});

test("replaced nodes and newly hidden sources invalidate an in-flight range", () => {
  const dom = new JSDOM("<article><p>This is the original paragraph.</p></article>");
  try {
    const document = dom.window.document;
    const original = collectRanges(document)[0];
    original.element.textContent = original.source;
    assert.equal(rangeStillMatches(original), false, "equal strings do not make replacement nodes the same source");
    const replacement = collectRanges(document)[0];
    replacement.element.parentElement!.style.opacity = "0";
    assert.equal(rangeStillMatches(replacement), false);
    assert.deepEqual(collectRanges(document), []);
  } finally { dom.window.close(); }
});

test("interactive inline source nodes are not hidden in translation-only mode", () => {
  const dom = new JSDOM("<p>This sentence includes a <a href='#'>reference</a> for the reader.</p>");
  try { assert.equal(canHideRange(collectRanges(dom.window.document)[0]), false); }
  finally { dom.window.close(); }
});

test("dynamic main content replaces fallback scope without duplicating blocks", () => {
  const dom = new JSDOM("<main></main><article><p>The fallback article is initially readable.</p></article>");
  try {
    const document = dom.window.document;
    assert.deepEqual(collectRanges(document).map((range) => range.source), ["The fallback article is initially readable."]);
    document.querySelector("main")!.innerHTML = "<section>The primary content has now appeared and should own scope.</section>";
    assert.deepEqual(collectRanges(document).map((range) => range.source), ["The primary content has now appeared and should own scope."]);
  } finally { dom.window.close(); }
});
