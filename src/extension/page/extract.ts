import type { ProtectedText } from "../../shared/protected-text.js";

const SEMANTIC_SELECTOR = "h1, h2, h3, h4, h5, h6, p, li, td, th, dt, dd, [role~='heading']";
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role~='heading']";
const MAIN_SELECTOR = "main, [role~='main']";
const CONTENT_ROOT_SELECTOR = `${MAIN_SELECTOR}, article`;
const GENERATED_SELECTOR = "[data-folio], [data-folio-ui]";
const OMITTED_TEXT_SELECTOR = [
  "script", "style", "noscript", "form", "input", "textarea", "select", "button",
  "pre", "[contenteditable]:not([contenteditable='false'])", GENERATED_SELECTOR,
  "nav", "footer", "aside", "[role~='navigation']", "[role~='banner']",
  "[role~='contentinfo']", "[role~='complementary']", "[role~='button']",
  "[role~='menu']", "[role~='menuitem']", "[role~='toolbar']", "[role~='dialog']",
].join(", ");
const PROTECTED_SELECTOR = "code, kbd, samp, math, [role='math']";
const NON_CONTENT_SELECTOR = `${OMITTED_TEXT_SELECTOR}, ${PROTECTED_SELECTOR}`;
const BOUNDARY_SELECTOR = [
  SEMANTIC_SELECTOR, "div", "ul", "ol", "table", "thead", "tbody", "tfoot", "tr",
  "caption", "figcaption", "main", "article", "section", "header", "blockquote", "dl", "br", "hr",
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
  /** Masked model input; protected values remain in this page's memory. */
  translationSource?: string;
  protectedText?: ProtectedText[];
  before: Node | null;
  after: Node | null;
  /** A scheduling hint within the same viewport tier; lower values read first. */
  readingPriority?: number;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Resolve inherited visibility at the auxiliary boundary using the browser's cascade. */
function readMathValue(wrapper: Element, read: () => string): string {
  const view = wrapper.ownerDocument.defaultView;
  if (!view || !['hidden', 'collapse'].includes(view.getComputedStyle(wrapper).visibility)) return read();
  const inline = (wrapper as HTMLElement).style;
  const original = wrapper.getAttribute('style');
  const nodes = [wrapper, ...wrapper.querySelectorAll('*')];
  const existing = new Set(wrapper.getAnimations({ subtree: true }));
  const visibilityTransition = (animation: Animation) =>
    'transitionProperty' in animation && animation.transitionProperty === 'visibility';
  const held = [...existing].filter(visibilityTransition).map(animation => {
    const effect = animation.effect as KeyframeEffect;
    return { animation, effect, target: effect.target, state: animation.playState,
      time: animation.currentTime, start: animation.startTime };
  });
  const settle = () => {
    // Resolve parents first: cancelling a parent's transition can start one on
    // its inheriting children. Leave unrelated page animations untouched.
    for (const node of nodes) for (const animation of node.getAnimations()) {
      if (visibilityTransition(animation) && !existing.has(animation)) animation.cancel();
    }
  };
  const restore = () => {
    // Flush CSSOM's lazy attribute serialization before removal; otherwise
    // Chromium can recreate an empty style attribute after removeAttribute.
    void wrapper.getAttribute('style');
    if (original === null) wrapper.removeAttribute('style');
    else wrapper.setAttribute('style', original);
  };
  // Synchronous, with no paint/yield. Only the wrapper's declaration changes.
  // Temporarily detach existing visibility effects so their intermediate values
  // cannot obscure the cascade; retain their identity, timing and playback state.
  try {
    for (const saved of held) saved.effect.target = null;
    inline.setProperty('visibility', 'visible', 'important');
    settle();
    return read();
  } finally {
    restore();
    settle();
    for (const saved of held) {
      saved.effect.target = saved.target;
      saved.animation.currentTime = saved.time;
      if (saved.state === 'paused') saved.animation.pause();
      else if (saved.state === 'running') {
        saved.animation.play();
        if (saved.start !== null) saved.animation.startTime = saved.start;
      }
    }
  }
}

/** Cache only during one extraction, so later DOM/style changes remain observable. */
function createReader(document: Document) {
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const visibility = new WeakMap<Element, boolean>();
  const boundaries = new WeakMap<Element, boolean>();
  const translationModes = new WeakMap<Element, boolean>();
  const mathPairs = new WeakMap<Element, { semantic: Element; value: string; inline: boolean } | null>();
  const view = document.defaultView;
  const style = (element: Element) => {
    let cached = styles.get(element);
    if (!cached && view) {
      cached = view.getComputedStyle(element);
      styles.set(element, cached);
    }
    return cached;
  };
  const locallyVisible = (element: Element): boolean => {
    const computed = style(element);
    return !element.hasAttribute("hidden")
      && element.getAttribute("aria-hidden") !== "true"
      && computed?.display !== "none"
      && computed?.visibility !== "hidden"
      && computed?.visibility !== "collapse"
      && computed?.contentVisibility !== "hidden"
      && Number.parseFloat(computed?.opacity ?? "") !== 0;
  };
  const visible = (element: Element): boolean => {
    const cached = visibility.get(element);
    if (cached !== undefined) return cached;
    const result = locallyVisible(element) && (!element.parentElement || visible(element.parentElement));
    visibility.set(element, result);
    return result;
  };
  const translatable = (element: Element): boolean => {
    if (element.closest(".notranslate")) return false;
    const cached = translationModes.get(element);
    if (cached !== undefined) return cached;
    const value = element.getAttribute("translate")?.toLowerCase();
    const result = value === "yes" || value === "" ? true : value === "no" ? false
      : !element.parentElement || translatable(element.parentElement);
    translationModes.set(element, result);
    return result;
  };
  // MediaWiki's MathJax renderer leaves a semantic MathML sibling behind. Only
  // this explicit pair may read through the auxiliary wrapper's hidden style;
  // arbitrary hidden text, SVG text and image alt remain outside the exception.
  const mathPair = (element: Element) => {
    if (mathPairs.has(element)) return mathPairs.get(element)!;
    mathPairs.set(element, null);
    if (!element.matches('.mwe-math-mathml-a11y, mjx-container')) return null;
    const sibling = (node: Node, direction: 'previousSibling' | 'nextSibling'): Node | null => {
      let next = adjacentOriginal(node, direction);
      while (next && (next.nodeType === next.COMMENT_NODE
        || (next.nodeType === next.TEXT_NODE && !normalize(next.textContent ?? '')))) {
        next = adjacentOriginal(next, direction);
      }
      return next;
    };
    const semantic = (element.matches('.mwe-math-mathml-a11y') ? element : sibling(element, 'previousSibling')) as Element | null;
    const rendered = (semantic && sibling(semantic, 'nextSibling')) as Element | null;
    if (semantic?.nodeType !== 1 || !semantic.matches('.mwe-math-mathml-a11y')
      || rendered?.nodeType !== 1 || !rendered.matches('mjx-container')
      // Before lazy typesetting, MathJax has no class or SVG yet.
      || (!rendered.classList.contains('MathJax') && !rendered.firstElementChild?.matches('mjx-lazy[data-mjx-lazy]'))
      || !visible(rendered) || !semantic.parentElement || !visible(semantic.parentElement)) return null;
    const math = semantic.firstElementChild;
    if (!math?.matches('math') || semantic.childElementCount !== 1
      || Array.from(semantic.childNodes).some(node => node.nodeType === node.TEXT_NODE && normalize(node.textContent ?? ''))) return null;
    const value = (node: Node): string => {
      if (node.nodeType === node.TEXT_NODE) return node.textContent ?? '';
      if (node.nodeType !== node.ELEMENT_NODE) return '';
      const child = node as Element;
      // MathML annotations are alternate encodings, not additional formula text.
      // Bypass only the auxiliary wrapper's hidden style, not styles on math
      // itself or its descendants. Stop at a hidden subtree as the normal reader does.
      if (child.matches(`annotation, annotation-xml, ${OMITTED_TEXT_SELECTOR}`) || !locallyVisible(child)) return '';
      return Array.from(child.childNodes).map(value).join('');
    };
    const display = style(rendered)?.display ?? '';
    const pair = { semantic, value: readMathValue(semantic, () => value(math)), inline: !math.matches('[display="block"], .mwe-math-element-block')
      && rendered.getAttribute('display') !== 'true'
      && (!display || ['inline', 'inline-block', 'contents'].includes(display)) };
    if (!normalize(pair.value)) return null;
    mathPairs.set(semantic, pair);
    mathPairs.set(rendered, pair);
    return pair;
  };
  const inlineMath = (node: Node) => node.nodeType === node.ELEMENT_NODE && mathPair(node as Element)?.inline === true;
  const protectedElement = (element: Element) => !!mathPair(element) || element.matches(PROTECTED_SELECTOR) || !translatable(element);
  const boundary = (element: Element): boolean => {
    const pair = mathPair(element);
    if (pair) return !pair.inline;
    if (element.matches('math[display="block"]')) return true;
    const display = style(element)?.display ?? "";
    return element.matches(BOUNDARY_SELECTOR)
      || (!!element.parentElement && translatable(element) && !translatable(element.parentElement))
      || (!!display && !["inline", "inline-block", "contents", "math", "inline math"].includes(display));
  };
  const containsBoundary = (element: Element): boolean => {
    // Inline MathML has its own layout tree; it is one protected value.
    if (mathPair(element) || element.matches(PROTECTED_SELECTOR)) return false;
    const cached = boundaries.get(element);
    if (cached !== undefined) return cached;
    const result = Array.from(element.children).some((child) =>
      !child.matches(OMITTED_TEXT_SELECTOR) && visible(child)
      && (boundary(child) || containsBoundary(child)),
    );
    boundaries.set(element, result);
    return result;
  };
  const text = (node: Node, excludeCode = false): string => {
    if (node.nodeType === node.TEXT_NODE) return excludeCode && node.parentElement && protectedElement(node.parentElement) ? "" : node.textContent ?? "";
    if (node.nodeType !== node.ELEMENT_NODE) return "";
    const element = node as Element;
    const pair = mathPair(element);
    if (pair) return !excludeCode && pair.inline && element === pair.semantic ? pair.value : '';
    if (element.matches(OMITTED_TEXT_SELECTOR) || (excludeCode && protectedElement(element)) || !visible(element)) return "";
    return Array.from(element.childNodes).map((child) => text(child, excludeCode)).join("");
  };
  const headingStyle = (element: Element): boolean => {
    const computed = style(element);
    const size = Number.parseFloat(computed?.fontSize ?? "");
    const parentSize = Number.parseFloat(element.parentElement ? style(element.parentElement)?.fontSize ?? "" : "");
    return Number.parseInt(computed?.fontWeight ?? "", 10) >= 600
      || computed?.fontWeight === "bold"
      || (Number.isFinite(parentSize) && size >= parentSize * 1.2);
  };
  return { visible, boundary, containsBoundary, text, headingStyle, translatable, protectedElement, inlineMath };
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
    while (nodes.length && !reader.inlineMath(nodes[0]) && !normalize(reader.text(nodes[0]))) nodes.shift();
    while (nodes.length && !reader.inlineMath(nodes[nodes.length - 1]) && !normalize(reader.text(nodes[nodes.length - 1]))) nodes.pop();
    const source = normalize(nodes.map((node) => reader.text(node)).join(""));
    if (source && eligible(element, nodes, source, reader)) {
      const protectedText: ProtectedText[] = [];
      let sequence = 0;
      const serialize = (node: Node): string => {
        if (node.nodeType !== node.ELEMENT_NODE) return reader.text(node);
        const child = node as Element;
        if (!reader.text(child)) return "";
        if (reader.protectedElement(child)) {
          let token: string;
          do { token = `⟪FOLIO:${sequence++}⟫`; } while (source.includes(token));
          protectedText.push({ token, text: reader.text(child) });
          return token;
        }
        return Array.from(child.childNodes).map(serialize).join("");
      };
      const translationSource = normalize(nodes.map(serialize).join(""));
      ranges.push({ element, nodes, source,
        ...(protectedText.length ? { translationSource, protectedText } : {}),
        before: adjacentOriginal(nodes[0], "previousSibling"),
        after: adjacentOriginal(nodes[nodes.length - 1], "nextSibling"),
      });
    }
    nodes = [];
  };
  for (const child of element.childNodes) {
    if (child.nodeType === child.ELEMENT_NODE) {
      const inline = child as Element;
      if (inline.matches(GENERATED_SELECTOR)) continue;
      if (inline.matches(OMITTED_TEXT_SELECTOR) || (!reader.inlineMath(inline) && !reader.visible(inline))
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
  if (!reader.translatable(element) || element.matches(PROTECTED_SELECTOR)) return false;
  // Inline code stays attached to surrounding prose, but code-only ranges and
  // numeric/UI punctuation alone are not translation candidates.
  const prose = normalize(nodes.map((node) => reader.text(node, true)).join(""));
  if (!/\p{L}/u.test(prose)) return false;
  // Exclude identifiers alone, not the surrounding prose of a useful paragraph.
  if (/^(?:https?:\/\/|www\.)\S+$/iu.test(prose)
    || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(prose)) return false;
  const links: Element[] = [];
  for (const node of nodes) {
    if (node.nodeType !== node.ELEMENT_NODE) continue;
    const child = node as Element;
    if (child.matches("a")) links.push(child);
    links.push(...child.querySelectorAll("a"));
  }
  const heading = !!element.closest(HEADING_SELECTOR);
  const linkTexts = links.map((link) => normalize(reader.text(link))).filter(Boolean);
  const linkedText = element.closest("a") ? source : linkTexts.join("");
  const linkDensity = linkedText.replace(/\s+/g, "").length / source.replace(/\s+/g, "").length;
  // Apply the same menu check to p/li and generic blocks. A single linked title
  // is still useful article text, unlike a row of visible, nonempty navigation links.
  if (linkDensity >= 0.8 && !(heading && linkTexts.length <= 1)) return false;

  // A styled inline wrapper may own a short run inside a semantic paragraph.
  if (element.matches(SEMANTIC_SELECTOR) || element.parentElement?.closest(SEMANTIC_SELECTOR)
    || element.matches("figcaption, caption")) return true;
  if (!reader.boundary(element)) return false;
  if (prose.length >= 24) return true;

  const letters = prose.match(/\p{L}/gu) ?? [];
  const words = prose.match(/\p{L}+/gu) ?? [];
  const shortPhrase = letters.length >= 4 && (words.length >= 2 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(prose));
  // Short generic labels need an explicit content/title signal. This avoids
  // turning every unmarked toolbar label into a paragraph.
  return (letters.length >= 2 && reader.headingStyle(element))
    || (shortPhrase && !!element.closest(CONTENT_ROOT_SELECTOR));
}

export function sameRange(left: SourceRange, right: SourceRange): boolean {
  return left.element === right.element && left.source === right.source
    && left.translationSource === right.translationSource
    && JSON.stringify(left.protectedText) === JSON.stringify(right.protectedText)
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

/** Re-read only known hosts after text edits; structural/scope edits use collectRanges. */
export function collectHostRanges(elements: Iterable<HTMLElement>): SourceRange[] {
  const hosts = [...elements];
  if (!hosts.length) return [];
  const reader = createReader(hosts[0].ownerDocument);
  return hosts.flatMap(element => element.isConnected && !element.closest(NON_CONTENT_SELECTOR)
    && reader.visible(element) ? directRanges(element, reader) : []);
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
  if (!previous || previous.matches(`${NON_CONTENT_SELECTOR}, ${CONTENT_ROOT_SELECTOR}`)) return [];
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
  const collect = (roots: HTMLElement[]): SourceRange[] => {
    const allowedHeaders = new Set(roots.map((root) => root.closest("header")));
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
    for (const root of roots) visit(root);
    return ranges;
  };
  let roots = outermost(mains);
  let ranges = collect(roots);
  // A declared main/article is a scope hint, not proof that it contains text.
  // Check its own candidates before adjacent titles can mask an empty root.
  if (!ranges.length || ranges.every(range => range.source.length < 24)) {
    const articles = outermost(Array.from(document.querySelectorAll<HTMLElement>("article"))
      .filter((element) => reader.visible(element) && !element.closest(NON_CONTENT_SELECTOR)));
    const articleRanges = collect(articles);
    if (!ranges.length || articleRanges.some(range => range.source.length >= 80)) {
      roots = articles;
      ranges = articleRanges;
    }
  }
  if (!ranges.length) { roots = [document.body]; ranges = collect(roots); }
  const externalTitles = outermost(roots.flatMap((root) => precedingHeadings(root, reader)))
    .filter((title) => !roots.some((root) => root.contains(title)));
  ranges.push(...collect(externalTitles));
  assignReadingPriorities(ranges, roots, reader);
  return ranges.sort((left, right) => {
    const first = left.nodes[0];
    const second = right.nodes[0];
    if (first === second) return 0;
    return first.compareDocumentPosition(second) & first.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}
