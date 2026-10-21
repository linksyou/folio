const SEMANTIC_SELECTOR = "h1, h2, h3, h4, h5, h6, p, li, td, th, dt, dd, [role~='heading']";
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role~='heading']";
const MAIN_SELECTOR = "main, [role~='main']";
const CONTENT_ROOT_SELECTOR = `${MAIN_SELECTOR}, article`;
const GENERATED_SELECTOR = "[data-open-web-translator], [data-open-web-translator-ui]";
const OMITTED_TEXT_SELECTOR = [
  "script", "style", "noscript", "form", "input", "textarea", "select", "button",
  "pre", "[contenteditable]:not([contenteditable='false'])", GENERATED_SELECTOR,
  "nav", "footer", "aside", "[role~='navigation']", "[role~='banner']",
  "[role~='contentinfo']", "[role~='complementary']", "[role~='button']",
  "[role~='menu']", "[role~='menuitem']", "[role~='toolbar']", "[role~='dialog']",
].join(", ");
const NON_CONTENT_SELECTOR = `${OMITTED_TEXT_SELECTOR}, code`;
const BOUNDARY_SELECTOR = [
  SEMANTIC_SELECTOR, "div", "ul", "ol", "table", "thead", "tbody", "tfoot", "tr",
  "caption", "main", "article", "section", "header", "blockquote", "dl", "br", "hr",
].join(", ");
const INTERACTIVE_SELECTOR = "a, button, input, textarea, select, [tabindex], [contenteditable], [role~='button']";
// Prioritize only a substantial, dominant article. This never changes extraction
// scope: summaries, controls and other eligible ranges remain in document order.
const FOCUSED_ARTICLE_MIN_CHARACTERS = 400;
const FOCUSED_ARTICLE_CONTENT_RATIO = 4;

/** A contiguous run of original siblings, with generated translations ignored. */
export interface SourceRange {
  element: HTMLElement;
  nodes: Node[];
  source: string;
  before: Node | null;
  after: Node | null;
  /** A scheduling hint within the same viewport tier; lower values read first. */
  readingPriority?: number;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cache only during one extraction, so later DOM/style changes remain observable. */
function createReader(document: Document) {
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const visibility = new WeakMap<Element, boolean>();
  const boundaries = new WeakMap<Element, boolean>();
  const view = document.defaultView;
  const style = (element: Element) => {
    let cached = styles.get(element);
    if (!cached && view) {
      cached = view.getComputedStyle(element);
      styles.set(element, cached);
    }
    return cached;
  };
  const visible = (element: Element): boolean => {
    const cached = visibility.get(element);
    if (cached !== undefined) return cached;
    const computed = style(element);
    const result = !element.hasAttribute("hidden")
      && element.getAttribute("aria-hidden") !== "true"
      && computed?.display !== "none"
      && computed?.visibility !== "hidden"
      && computed?.visibility !== "collapse"
      && computed?.contentVisibility !== "hidden"
      && (!element.parentElement || visible(element.parentElement));
    visibility.set(element, result);
    return result;
  };
  const boundary = (element: Element): boolean => {
    const display = style(element)?.display ?? "";
    return element.matches(BOUNDARY_SELECTOR)
      || (!!display && !["inline", "inline-block", "contents"].includes(display));
  };
  const containsBoundary = (element: Element): boolean => {
    const cached = boundaries.get(element);
    if (cached !== undefined) return cached;
    const result = Array.from(element.children).some((child) =>
      !child.matches(OMITTED_TEXT_SELECTOR) && visible(child)
      && (boundary(child) || containsBoundary(child)),
    );
    boundaries.set(element, result);
    return result;
  };
  const text = (node: Node): string => {
    if (node.nodeType === node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== node.ELEMENT_NODE) return "";
    const element = node as Element;
    if (element.matches(OMITTED_TEXT_SELECTOR) || !visible(element)) return "";
    return Array.from(element.childNodes).map(text).join("");
  };
  return { visible, boundary, containsBoundary, text };
}

type Reader = ReturnType<typeof createReader>;

function adjacentOriginal(node: Node, direction: "previousSibling" | "nextSibling"): Node | null {
  let adjacent = node[direction];
  while (adjacent && adjacent.nodeType === adjacent.ELEMENT_NODE && (adjacent as Element).matches(GENERATED_SELECTOR)) {
    adjacent = adjacent[direction];
  }
  return adjacent;
}

/**
 * Inline descendants remain original nodes. A nested block, break or omitted
 * sibling closes the current run, so text on opposite sides never shares an anchor.
 */
function directRanges(element: HTMLElement, reader: Reader): SourceRange[] {
  const ranges: SourceRange[] = [];
  let nodes: Node[] = [];
  const flush = () => {
    while (nodes.length && !normalize(reader.text(nodes[0]))) nodes.shift();
    while (nodes.length && !normalize(reader.text(nodes[nodes.length - 1]))) nodes.pop();
    const source = normalize(nodes.map(reader.text).join(""));
    if (source && eligible(element, nodes, source, reader)) ranges.push({
      element, nodes, source,
      before: adjacentOriginal(nodes[0], "previousSibling"),
      after: adjacentOriginal(nodes[nodes.length - 1], "nextSibling"),
    });
    nodes = [];
  };
  for (const child of element.childNodes) {
    if (child.nodeType === child.ELEMENT_NODE) {
      const inline = child as Element;
      if (inline.matches(GENERATED_SELECTOR)) continue;
      if (inline.matches(OMITTED_TEXT_SELECTOR) || !reader.visible(inline)
        || reader.boundary(inline) || reader.containsBoundary(inline)) {
        flush();
        continue;
      }
    } else if (child.nodeType !== child.TEXT_NODE && child.nodeType !== child.COMMENT_NODE) {
      flush();
      continue;
    }
    nodes.push(child);
  }
  flush();
  return ranges;
}

function eligible(element: HTMLElement, nodes: Node[], source: string, reader: Reader): boolean {
  // A styled inline wrapper may own a short run inside a semantic paragraph.
  if (element.matches(SEMANTIC_SELECTOR) || element.parentElement?.closest(SEMANTIC_SELECTOR)) return true;
  if (element.tagName !== "DIV" || source.length < 24) return false;
  const links: Element[] = [];
  for (const node of nodes) {
    if (node.nodeType !== node.ELEMENT_NODE) continue;
    const child = node as Element;
    if (child.matches("a")) links.push(child);
    links.push(...child.querySelectorAll("a"));
  }
  const linkedText = links.map(reader.text).join("").replace(/\s+/g, "");
  return linkedText.length < source.replace(/\s+/g, "").length * 0.8;
}

export function sameRange(left: SourceRange, right: SourceRange): boolean {
  return left.element === right.element && left.source === right.source
    && left.before === right.before && left.after === right.after
    && left.nodes.length === right.nodes.length
    && left.nodes.every((node, index) => node === right.nodes[index]);
}

/** Re-read this host only; node identity matters even when replacement text is identical. */
export function rangeStillMatches(range: SourceRange): boolean {
  const { element } = range;
  if (!element.isConnected || element.closest(OMITTED_TEXT_SELECTOR)) return false;
  if (range.nodes.some((node) => node.parentNode !== element)) return false;
  const reader = createReader(element.ownerDocument);
  return reader.visible(element) && directRanges(element, reader).some((current) => sameRange(range, current));
}

/** Only hide a complete safe run; independent blocks and interactive content stay visible. */
export function canHideRange(range: SourceRange): boolean {
  if (!rangeStillMatches(range) || range.element.tagName === "LI"
    || range.element.closest(INTERACTIVE_SELECTOR)) return false;
  const selected = new Set(range.nodes);
  if (Array.from(range.element.childNodes).some((node) => {
    if (selected.has(node) || node.nodeType === node.COMMENT_NODE) return false;
    if (node.nodeType === node.TEXT_NODE) return !!normalize(node.textContent ?? "");
    return node.nodeType === node.ELEMENT_NODE && !(node as Element).matches(GENERATED_SELECTOR);
  })) return false;
  return range.nodes.every((node) => {
    if (node.nodeType !== node.ELEMENT_NODE) return true;
    const element = node as Element;
    return !element.matches(INTERACTIVE_SELECTOR) && !element.querySelector(INTERACTIVE_SELECTOR);
  });
}

function outermost(elements: HTMLElement[]): HTMLElement[] {
  const selected = new Set(elements);
  return elements.filter((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (selected.has(parent)) return false;
    }
    return true;
  });
}

/** Accept one explicit heading immediately before main/article, excluding site navigation. */
function precedingHeadings(root: HTMLElement, reader?: Reader): HTMLElement[] {
  let previous = root.previousElementSibling as HTMLElement | null;
  while (previous && reader && (!reader.visible(previous)
    || (previous.childElementCount === 0 && !normalize(previous.textContent ?? "")))) {
    previous = previous.previousElementSibling as HTMLElement | null;
  }
  if (!previous || previous.matches(NON_CONTENT_SELECTOR)) return [];
  if (previous.matches(HEADING_SELECTOR)) return [previous];
  if (previous.querySelector("nav, [role~='navigation'], [role~='banner'], main, article")) return [];
  const headings = outermost(Array.from(previous.querySelectorAll<HTMLElement>(HEADING_SELECTOR)));
  if (headings.length !== 1) return [];
  const heading = headings[0];
  if (previous.tagName === "HEADER" && heading.querySelector("a")) return [];
  return [heading];
}

function articleHeadings(article: HTMLElement, main: HTMLElement, reader: Reader, ranges: SourceRange[]): HTMLElement[] {
  const headings: HTMLElement[] = [];
  let current = article;
  while (current !== main) {
    headings.push(...precedingHeadings(current, reader));
    const parent = current.parentElement;
    if (!parent || parent === main) break;
    // A neutral wrapper must not separate an article from its adjacent title.
    const siblings = Array.from(parent.children).filter((child) => child.contains(article)
      || ranges.some((range) => child.contains(range.element)));
    if (siblings.length !== 1 || ranges.some((range) => range.element === parent)) break;
    current = parent;
  }
  return headings;
}

/**
 * Some document viewers wrap an article in main together with file/navigation
 * headings. Give a dominant article an earlier turn within the same viewport,
 * without guessing whether its other text is a summary, metadata or discussion.
 */
function assignReadingPriorities(ranges: SourceRange[], roots: HTMLElement[], reader: Reader): void {
  for (const range of ranges) range.readingPriority = 1;
  for (const main of roots.filter((root) => root.matches(MAIN_SELECTOR))) {
    const articles = outermost(Array.from(main.querySelectorAll<HTMLElement>("article"))
      .filter((article) => reader.visible(article) && !article.closest(NON_CONTENT_SELECTOR)));
    if (articles.length !== 1) continue;
    const article = articles[0];
    const inside = ranges.filter((range) => article.contains(range.element));
    const outside = ranges.filter((range) => main.contains(range.element) && !article.contains(range.element));
    const articleCharacters = inside.reduce((sum, range) => sum + range.source.length, 0);
    const outsideCharacters = outside.reduce((sum, range) => sum + range.source.length, 0);
    if (articleCharacters < FOCUSED_ARTICLE_MIN_CHARACTERS
      || articleCharacters < outsideCharacters * FOCUSED_ARTICLE_CONTENT_RATIO) continue;
    const titles = articleHeadings(article, main, reader, ranges);
    for (const range of [...inside, ...outside]) {
      if (article.contains(range.element) || titles.some((title) => title.contains(range.element))) {
        range.readingPriority = 0;
      }
    }
  }
}

/** Return independent original node runs in document order, without changing the page. */
export function collectRanges(document: Document): SourceRange[] {
  if (!document.body) return [];
  const reader = createReader(document);
  const mains = Array.from(document.querySelectorAll<HTMLElement>(MAIN_SELECTOR))
    .filter((element) => reader.visible(element) && !element.closest(NON_CONTENT_SELECTOR));
  const articles = mains.length ? [] : Array.from(document.querySelectorAll<HTMLElement>("article"))
    .filter((element) => reader.visible(element) && !element.closest(NON_CONTENT_SELECTOR));
  const roots = outermost(mains.length ? mains : articles.length ? articles : [document.body]);
  const externalTitles = roots.flatMap((root) => precedingHeadings(root));
  const allowedHeaders = new Set(externalTitles.map((heading) => heading.closest("header")));
  const ranges: SourceRange[] = [];
  const visit = (element: HTMLElement): void => {
    if (element.closest(NON_CONTENT_SELECTOR) || !reader.visible(element)) return;
    if (element.tagName === "HEADER" && !element.closest(CONTENT_ROOT_SELECTOR) && !allowedHeaders.has(element)) return;
    ranges.push(...directRanges(element, reader));
    for (const child of element.children) {
      // Atomic inline nodes were already included in their parent's range.
      if (reader.boundary(child) || reader.containsBoundary(child)) visit(child as HTMLElement);
    }
  };
  for (const root of outermost([...externalTitles, ...roots])) visit(root);
  assignReadingPriorities(ranges, roots, reader);
  return ranges.sort((left, right) => {
    const first = left.nodes[0];
    const second = right.nodes[0];
    if (first === second) return 0;
    return first.compareDocumentPosition(second) & first.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}
