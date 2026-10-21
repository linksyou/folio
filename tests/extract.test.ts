import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { canHideRange, collectRanges, rangeStillMatches, sameRange } from "../src/extension/page/extract.js";

function extract(html: string) {
  const document = new JSDOM(html).window.document;
  const ranges = collectRanges(document);
  return { document, ranges, elements: ranges.map((range) => range.element), texts: ranges.map((range) => range.source) };
}

test("includes article header headings and every article within main", () => {
  const { texts } = extract(`
    <header><h1>Site brand</h1><nav><p>Site navigation</p></nav></header>
    <main>
      <article><header><h1>First article</h1><p>First introduction</p></header><p>First body</p></article>
      <h2>Another section</h2>
      <article><header><h2>Second article</h2></header><p>Second body</p></article>
    </main>
  `);
  assert.deepEqual(texts, [
    "First article", "First introduction", "First body", "Another section", "Second article", "Second body",
  ]);
});

test("includes an adjacent page heading outside main and article", () => {
  assert.deepEqual(extract("<h1>Page title</h1><main><p>Body</p></main>").texts, ["Page title", "Body"]);
  assert.deepEqual(extract("<div><h1>Article title</h1></div><article><p>Body</p></article>").texts, [
    "Article title", "Body",
  ]);
  assert.deepEqual(extract("<header><h1>Page title</h1></header><main><p>Body</p></main>").texts, [
    "Page title", "Body",
  ]);
  assert.deepEqual(extract(`
    <div><h1><span role="heading">Nested page title</span></h1></div><main><p>Body</p></main>
  `).texts, ["Nested page title", "Body"]);
});

test("does not collect navigation or a linked site brand adjacent to main", () => {
  const { texts } = extract(`
    <header><h1><a href="/">Site brand</a></h1></header>
    <main>
      <nav><h2>Contents</h2><ul><li><a href="#body">Navigation link</a></li></ul></nav>
      <section role="navigation"><p>More navigation</p></section>
      <header role="banner"><h2>Site banner</h2></header>
      <aside><p>Related content</p></aside>
      <article><header><h1>Article heading</h1></header><p>Body</p></article>
      <footer><p>Site footer</p></footer>
    </main>
  `);
  assert.deepEqual(texts, ["Article heading", "Body"]);
  assert.deepEqual(extract(`
    <header><h1>Site brand</h1><nav>Menu</nav></header><main><p>Body</p></main>
  `).texts, ["Body"]);
});

test("collects all article roots and supports main and heading ARIA roles", () => {
  assert.deepEqual(extract(`
    <article><h1>One</h1><p>First</p></article>
    <article><h2>Two</h2><p>Second</p></article>
  `).texts, ["One", "First", "Two", "Second"]);
  assert.deepEqual(extract(`
    <div role="main">
      <div role="heading" aria-level="1">Role title</div>
      <article><span role="heading" aria-level="2">Role subtitle</span><p>Body</p></article>
      <span class="title">Unspecified metadata</span>
    </div>
  `).texts, ["Role title", "Role subtitle", "Body"]);
});

test("ignores hidden and interactive content without changing inline links or code", () => {
  const { document, elements, texts } = extract(`
    <main>
      <div hidden><h1>Hidden ancestor</h1></div>
      <section style="display:none"><p>Display none ancestor</p></section>
      <p aria-hidden="true">ARIA hidden block</p>
      <p style="visibility:hidden">Invisible block</p>
      <pre><code>Standalone code</code></pre>
      <form><p>Form content</p></form>
      <div contenteditable="true"><p>Editable content</p></div>
      <p>Read <a href="/more">this link</a> and <code>inline()</code>.<br>Next line.
        <span hidden>Hidden text</span><span style="display:none">Display none text</span>
        <span contenteditable="true">Editable text</span><button>Button text</button>
        <span data-open-web-translator="translation">Old translation</span>
      </p>
    </main>
  `);
  assert.deepEqual(texts, ["Read this link and inline().", "Next line."]);
  assert.equal(elements.length, 2);
  assert.equal(document.querySelector("a")?.getAttribute("href"), "/more");
  assert.equal(document.querySelector("p code")?.textContent, "inline()");
  assert.equal(document.querySelector("[data-open-web-translator]")?.textContent, "Old translation");
});

test("nested semantic blocks yield only non-overlapping leaf elements", () => {
  const { elements, texts } = extract(`
    <main><main>
      <h1><span role="heading" aria-level="1">One title</span></h1>
      <ul><li><p>One paragraph</p><ul><li>Nested list item</li></ul></li></ul>
    </main></main>
  `);
  assert.deepEqual(texts, ["One title", "One paragraph", "Nested list item"]);
  for (const element of elements) {
    assert.equal(elements.some((other) => other !== element && element.contains(other)), false);
  }
});

test("body fallback excludes global headers but allows article headers", () => {
  const { texts } = extract(`
    <header><h1>Site title</h1></header>
    <div><h1>Page title</h1><p>Body</p></div>
    <nav><p>Navigation</p></nav>
    <footer><p>Footer</p></footer>
  `);
  assert.deepEqual(texts, ["Page title", "Body"]);
});

test("visibility is refreshed after page styles change", () => {
  const { document } = extract("<main><p>Paragraph</p></main>");
  const paragraph = document.querySelector("p")!;
  assert.deepEqual(collectRanges(document).map((range) => range.element), [paragraph]);
  paragraph.parentElement!.style.display = "none";
  assert.deepEqual(collectRanges(document), []);
  paragraph.parentElement!.style.display = "block";
  assert.deepEqual(collectRanges(document).map((range) => range.element), [paragraph]);
  assert.equal(collectRanges(document)[0].source, "Paragraph");
});

test("nested list items keep parent inline text without translating descendant text twice", () => {
  const { texts } = extract(`<main><ul><li>
    Parent <a href='/parent'>linked text</a> before.
    <p>Independent child paragraph.</p><ul><li>Nested list item.</li></ul>
    Parent text after.
  </li></ul></main>`);
  assert.deepEqual(texts, [
    "Parent linked text before.", "Independent child paragraph.", "Nested list item.", "Parent text after.",
  ]);
});

test("bounded div fallback collects prose but excludes short UI, navigation and link-only blocks", () => {
  const { texts } = extract(`<main>
    <div>Direct prose made from divs with <em>inline emphasis</em>.</div>
    <div><div>Nested div prose remains a single independently translated region.</div></div>
    <div>Loading…</div><div role='button'>Long interactive control must never become an article paragraph.</div>
    <nav><div>Navigation text is long enough but still must never be translated.</div></nav>
    <div><a href='/one'>Entirely linked navigation item, despite its considerable length.</a></div>
    <div><p>Paragraph inside div wrapper.</p></div>
  </main>`);
  assert.deepEqual(texts, [
    "Direct prose made from divs with inline emphasis.",
    "Nested div prose remains a single independently translated region.",
    "Paragraph inside div wrapper.",
  ]);
  assert.deepEqual(extract("<div role='main'>A main role with only direct div prose should also be translated.</div>").texts,
    ["A main role with only direct div prose should also be translated."]);
});

test("each nested list run retains its exact original siblings and boundary anchors", () => {
  const { document, ranges, texts } = extract(`<main><ul><li id="parent">User: <strong>Before</strong><ul id="nested"><li>dot: Child</li></ul>After <em>the child</em></li></ul></main>`);
  const parent = document.querySelector<HTMLElement>("#parent")!;
  const nested = document.querySelector("#nested")!;
  assert.deepEqual(texts, ["User: Before", "dot: Child", "After the child"]);
  assert.equal(ranges[0].element, parent);
  assert.deepEqual(ranges[0].nodes, [parent.childNodes[0], parent.childNodes[1]]);
  assert.equal(ranges[0].before, null);
  assert.equal(ranges[0].after, nested);
  assert.equal(ranges[2].element, parent);
  assert.equal(ranges[2].before, nested);
  assert.equal(ranges[2].after, null);
  assert.equal(canHideRange(ranges[0]), false);
});

test("table headers and cells have independent ranges instead of leaking into a wrapper", () => {
  const { ranges, texts } = extract(`<main><div><article>
    <table><thead><tr><th>name</th><th>description</th></tr></thead>
    <tbody><tr><td>secure-me</td><td>Public example description.</td></tr></tbody></table>
    <p>Following article paragraph.</p>
  </article></div></main>`);
  assert.deepEqual(texts, ["name", "description", "secure-me", "Public example description.", "Following article paragraph."]);
  assert.deepEqual(ranges.map((range) => range.element.tagName), ["TH", "TH", "TD", "TD", "P"]);
  for (const range of ranges) assert.ok(range.nodes.every((node) => node.parentNode === range.element));
});

test("flex and grid paragraphs keep ranges inside the original layout item", () => {
  const { document, ranges } = extract(`<main>
    <div id="flex" style="display:flex"><h2>A title</h2><p>A paragraph.</p></div>
    <div id="grid" style="display:grid"><h3>Another title</h3><p>Another paragraph.</p></div>
  </main>`);
  assert.deepEqual(ranges.map((range) => range.element.tagName), ["H2", "P", "H3", "P"]);
  assert.equal(document.querySelector("#flex")!.children.length, 2);
  assert.equal(document.querySelector("#grid")!.children.length, 2);
  for (const range of ranges) {
    assert.equal(range.nodes[0].parentNode, range.element);
    assert.equal(range.after, null);
  }
});

test("computed block displays and BR split a paragraph into separately anchored runs", () => {
  const { document, ranges, texts } = extract(`<main><p id="source">Before<span style="display:block">Middle <em>block</em></span>After<br>Final</p></main>`);
  assert.deepEqual(texts, ["Before", "Middle block", "After", "Final"]);
  assert.equal(ranges[0].after, document.querySelector("span"));
  assert.equal(ranges[1].element, document.querySelector("span"));
  assert.equal(ranges[2].after, document.querySelector("br"));
  assert.equal(ranges[3].before, document.querySelector("br"));
  assert.equal(canHideRange(ranges[0]), false);
});

test("inline wrappers with nested blocks do not absorb text from both sides", () => {
  const { document, texts, ranges } = extract(`<main><p>Outer <span id="mixed">Inner before <span style="display:block">Inner block</span>Inner after</span> Outer after</p></main>`);
  assert.deepEqual(texts, ["Outer", "Inner before", "Inner block", "Inner after", "Outer after"]);
  assert.equal(ranges[0].after, document.querySelector("#mixed"));
  assert.equal(ranges[1].element, document.querySelector("#mixed"));
  assert.equal(ranges[3].element, document.querySelector("#mixed"));
});

test("range identity rejects edits, identical replacement nodes, reordering and inserted boundaries", () => {
  const changedText = extract("<main><p>Original text.</p></main>");
  assert.equal(rangeStillMatches(changedText.ranges[0]), true);
  changedText.ranges[0].nodes[0].textContent = "Edited text.";
  assert.equal(rangeStillMatches(changedText.ranges[0]), false);

  const replaced = extract("<main><p>Same text.</p></main>");
  replaced.ranges[0].element.replaceChildren(replaced.document.createTextNode("Same text."));
  assert.equal(rangeStillMatches(replaced.ranges[0]), false);
  assert.equal(sameRange(replaced.ranges[0], collectRanges(replaced.document)[0]), false);

  const reordered = extract("<main><p><span>Same</span> <em>Same</em></p></main>");
  reordered.ranges[0].element.prepend(reordered.ranges[0].nodes[2]);
  assert.equal(rangeStillMatches(reordered.ranges[0]), false);

  const inserted = extract("<main><p>First <span>second</span></p></main>");
  inserted.ranges[0].element.insertBefore(inserted.document.createElement("br"), inserted.ranges[0].nodes[1]);
  assert.equal(rangeStillMatches(inserted.ranges[0]), false);

  const addedText = extract("<main><p>Original text.</p></main>");
  addedText.ranges[0].element.append(addedText.document.createTextNode(" Newly added text."));
  assert.equal(rangeStillMatches(addedText.ranges[0]), false);
});

test("moving the same text across a nested list invalidates its old boundary snapshot", () => {
  const { document, ranges } = extract("<main><ul><li id='parent'>Same text.<ul><li>Child.</li></ul></li></ul></main>");
  const range = ranges[0];
  range.element.append(range.nodes[0]);
  assert.equal(rangeStillMatches(range), false);
  const replacement = collectRanges(document).find((current) => current.element.id === "parent")!;
  assert.deepEqual(replacement.nodes, range.nodes);
  assert.equal(replacement.source, range.source);
  assert.equal(sameRange(range, replacement), false);
});

test("generated translations do not become sources or invalidate original boundaries", () => {
  const { document, ranges } = extract("<main><ul><li>Parent.<ul><li>Child.</li></ul></li></ul><p>Safe <em>paragraph.</em></p></main>");
  for (const range of ranges) {
    const output = document.createElement("span");
    output.dataset.openWebTranslator = "translation";
    output.textContent = "Generated translation.";
    range.element.insertBefore(output, range.nodes.at(-1)!.nextSibling);
  }
  const again = collectRanges(document);
  assert.equal(again.length, ranges.length);
  for (let index = 0; index < ranges.length; index++) {
    assert.equal(sameRange(ranges[index], again[index]), true);
    assert.equal(rangeStillMatches(ranges[index]), true);
  }
  assert.equal(canHideRange(ranges[2]), true);
});

test("only complete non-interactive ranges can hide their original nodes", () => {
  const { ranges } = extract(`<main>
    <p>Safe <em>paragraph</em> with <code>inline code</code>.</p>
    <p>Keep the <a href='/link'>link</a> accessible.</p>
    <p>Before<br>After</p>
    <p>Visible text<button>Action</button></p>
    <ul><li>A list item.</li></ul>
    <table><tbody><tr><td>Cell text.</td></tr></tbody></table>
  </main>`);
  assert.deepEqual(ranges.map(canHideRange), [true, false, false, false, false, false, true]);
});

test("a dominant article gains reading priority without filtering or reordering original ranges", () => {
  const body = "Article prose remains independently readable. ".repeat(20).trim();
  const { texts, ranges } = extract(`<main>
    <h2>File navigation</h2>
    <div>File information and other metadata.</div>
    <h1>Adjacent article title</h1>
    <div><article><h2>Inside title</h2><p>${body}</p></article></div>
  </main>`);
  assert.deepEqual(texts, [
    "File navigation", "File information and other metadata.", "Adjacent article title", "Inside title", body,
  ]);
  assert.deepEqual(ranges.map((range) => range.readingPriority), [1, 1, 0, 0, 0]);
});

test("article priority preserves short summaries in semantic paragraphs and divs of any accepted length", () => {
  const body = "Substantial article prose. ".repeat(30).trim();
  for (const summary of ["A short but important summary before the article.", "x".repeat(79), "x".repeat(80)]) {
    for (const tag of ["p", "div"]) {
      const { texts, ranges } = extract(`<main><h1>Page title</h1><${tag}>${summary}</${tag}>
        <article><p>${body}</p></article></main>`);
      assert.deepEqual(texts, ["Page title", summary, body]);
      assert.deepEqual(ranges.map((range) => range.readingPriority), [1, 1, 0]);
    }
  }
});

test("article priority keeps adjacent headings across hidden nodes and empty wrappers", () => {
  const body = "Article paragraph with enough substantial content. ".repeat(12).trim();
  for (const content of [
    `<h1>Article title</h1><div hidden>Hidden separator</div><article><p>${body}</p></article>`,
    `<h1>Article title</h1><div><div></div><article><p>${body}</p></article></div>`,
  ]) {
    const { texts, ranges } = extract(`<main>${content}</main>`);
    assert.deepEqual(texts, ["Article title", body]);
    assert.deepEqual(ranges.map((range) => range.readingPriority), [0, 0]);
  }
  const { ranges } = extract(`<main><h1>Independent section</h1><div><p>Separate summary.</p>
    <article><p>${body}</p></article></div></main>`);
  assert.deepEqual(ranges.map((range) => range.readingPriority), [1, 1, 0]);
});

test("short cards, multiple articles and substantial outside content retain equal reading priority", () => {
  const body = "Article content. ".repeat(30).trim();
  for (const content of [
    `<h1>Page</h1><article><p>Short article card.</p></article>`,
    `<h1>Page</h1><article><p>${body}</p></article><article><p>Second article.</p></article>`,
    `<p>${"Main content. ".repeat(12)}</p><article><p>${body}</p></article>`,
  ]) {
    const { ranges } = extract(`<main>${content}</main>`);
    assert.ok(ranges.length >= 2);
    assert.ok(ranges.every((range) => range.readingPriority === 1));
  }
});

test("reading priority is refreshed independently from original range identity", () => {
  const body = "Article content. ".repeat(30).trim();
  const { document, ranges } = extract(`<main><h2>File navigation</h2><div>File information and other metadata.</div>
    <article><p>${body}</p></article></main>`);
  assert.deepEqual(ranges.map((range) => range.readingPriority), [1, 1, 0]);
  const summary = document.createElement("p");
  summary.textContent = "Additional main content. ".repeat(10);
  document.querySelector("main")!.append(summary);
  const updated = collectRanges(document);
  assert.ok(updated.every((range) => range.readingPriority === 1));
  assert.ok(ranges.every((range, index) => sameRange(range, updated[index])));
  summary.remove();
  assert.deepEqual(collectRanges(document).map((range) => range.readingPriority), [1, 1, 0]);
});
