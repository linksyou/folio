import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { canHideRange, collectRanges, rangeStillMatches } from '../src/extension/page/extract.js';
import { formulaMasked, formulaParagraph, formulaSource, lazyMath, mathValue, pairedMath, renderedMath } from './fixtures/paired-math.js';

for (const style of ['display:none', 'display:block;position:absolute;width:1px;height:1px;clip-path:inset(50%)']) {
  test(`paired inline math stays in one protected paragraph (${style})`, () => {
    const dom = new JSDOM(`<main><p>${formulaParagraph(value => pairedMath(value, style))}</p></main>`);
    try {
      const ranges = collectRanges(dom.window.document);
      assert.equal(ranges.length, 1);
      assert.equal(ranges[0].source, formulaSource);
      assert.equal(ranges[0].translationSource, formulaMasked);
      assert.deepEqual(ranges[0].protectedText?.map(p => p.text), ['demb', 'dmodel']);
      assert(canHideRange(ranges[0]));
      dom.window.document.querySelector('mtext')!.textContent = 'changed';
      assert(!rangeStillMatches(ranges[0]));
      assert.equal(collectRanges(dom.window.document)[0].protectedText?.[0].text, 'dchanged');
    } finally { dom.window.close(); }
  });
}

test('formula at a paragraph edge keeps both original nodes in its anchor', () => {
  const dom = new JSDOM(`<p>${pairedMath('first')} begins this explanation and ends with ${pairedMath('last')}</p>`);
  try {
    const range = collectRanges(dom.window.document)[0];
    assert.equal(range.nodes.at(-1), dom.window.document.querySelector('p')!.lastChild);
    assert.equal(range.after, null);
    assert(canHideRange(range));
  } finally { dom.window.close(); }
});

test('nested and lazy paired formulas preserve the same masking contract', () => {
  for (const formula of [(value: string) => `<em>${pairedMath(value)}</em>`,
    (value: string) => pairedMath(value).replace(renderedMath, lazyMath)]) {
    const dom = new JSDOM(`<p>${formulaParagraph(formula)}</p>`);
    try {
      const [range] = collectRanges(dom.window.document);
      assert.equal(range.source, formulaSource);
      assert.equal(range.translationSource, formulaMasked);
    } finally { dom.window.close(); }
  }
});

test('display equations remain boundaries before and after rendering', () => {
  // Native MathML CSS is checked in Chromium: jsdom 26 cannot compute its style.
  for (const formula of [pairedMath('block').replace('<math ', '<math display="block" '),
    pairedMath('block').replace('<mjx-container ', '<mjx-container display="true" ')]) {
    const dom = new JSDOM(`<p>Before the equation.${formula}After the equation.</p>`);
    try { assert.deepEqual(collectRanges(dom.window.document).map(r => r.source), ['Before the equation.', 'After the equation.']); }
    finally { dom.window.close(); }
  }
});

test('unrelated hidden content and unpaired math are never read through the pair exception', () => {
  const dom = new JSDOM(`<main><p>Readable introduction.
    <span hidden>HIDDEN_CANARY</span>
    <span style="display:none">${mathValue('PRIVATE')}</span>${renderedMath}
    <span class="mwe-math-mathml-a11y" style="display:none">${mathValue('ORPHAN')}</span>Intervening prose.${renderedMath}
    <img alt="ALT_CANARY"><svg aria-hidden="true"><text>SVG_CANARY</text></svg>
    Readable ending.</p><p hidden>${formulaParagraph()}</p><p translate="no">${formulaParagraph()}</p>
    <p class="notranslate">${formulaParagraph()}</p></main>`);
  try {
    const text = collectRanges(dom.window.document).map(r => r.translationSource ?? r.source).join(' ');
    assert(!/CANARY|PRIVATE|ORPHAN|dimension/.test(text), text);
    assert(text.includes('Readable introduction.') && text.includes('Intervening prose.') && text.includes('Readable ending.'));
  } finally { dom.window.close(); }
});
