import { PageTranslator } from '../../src/extension/page/PageTranslator.js';
import { canHideRange, collectRanges, rangeStillMatches } from '../../src/extension/page/extract.js';
import { TranslationCache } from '../../src/extension/translation-cache.js';
import { TranslationReuse } from '../../src/extension/translation-reuse.js';
import { publicError } from '../../src/shared/errors.js';
import { formulaMasked, formulaParagraph, formulaSource, lazyMath, mathValue, pairedMath, renderedMath } from '../fixtures/paired-math.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const outputs = (root: ParentNode = document) => [...root.querySelectorAll('[data-folio="translation"]')];
const reset = (html: string) => { document.body.innerHTML = `<main>${html}</main>`; window.scrollTo(0, 0); };

// These extraction assertions use Chromium: jsdom 26 cannot compute MathML CSS.
export function pairedMathExtractionRegression() {
  for (const style of ['display:none', 'display:block;position:absolute;width:1px;height:1px;clip-path:inset(50%)']) {
    reset(`<p>${formulaParagraph(value => pairedMath(value, style))}</p>`);
    const ranges = collectRanges(document);
    check(ranges.length === 1 && ranges[0].source === formulaSource && ranges[0].translationSource === formulaMasked,
      'paired math fragmented');
    check(JSON.stringify(ranges[0].protectedText?.map(p => p.text)) === JSON.stringify(['demb', 'dmodel']), 'wrong protected values');
    check(canHideRange(ranges[0]), 'safe paragraph cannot hide');
    document.querySelector('mtext')!.textContent = 'changed';
    check(!rangeStillMatches(ranges[0]), 'formula text edit did not invalidate the range');
    check(collectRanges(document)[0].protectedText?.[0].text === 'dchanged', 'formula text edit not reread');
  }
  reset(`<p>${pairedMath('first')} begins this explanation and ends with ${pairedMath('last')}</p>`);
  const range = collectRanges(document)[0];
  check(range.nodes.at(-1) === document.querySelector('p')!.lastChild && range.after === null && canHideRange(range),
    'formula edge lost its rendered anchor');
  reset(`<p>Readable introduction.<span hidden>HIDDEN_CANARY</span>
    <span style="display:none">${mathValue('PRIVATE')}</span>${renderedMath}
    <span class="mwe-math-mathml-a11y" style="display:none">${mathValue('ORPHAN')}</span>Intervening prose.${renderedMath}
    <img alt="ALT_CANARY"><svg aria-hidden="true"><text>SVG_CANARY</text></svg>Readable ending.</p>
    <p hidden>${formulaParagraph()}</p><p translate="no">${formulaParagraph()}</p><p class="notranslate">${formulaParagraph()}</p>`);
  const text = collectRanges(document).map(r => r.translationSource ?? r.source).join(' ');
  check(!/CANARY|PRIVATE|ORPHAN|dimension/.test(text) && text.includes('Readable introduction.')
    && text.includes('Intervening prose.') && text.includes('Readable ending.'), 'hidden/unpaired content escaped');

  const hiddenCases = [
    '<mtext style="display:none">HIDDEN_CANARY</mtext>',
    '<mtext style="visibility:hidden">HIDDEN_CANARY</mtext>',
    '<mtext style="visibility:collapse">HIDDEN_CANARY</mtext>',
    '<mtext style="opacity:0">HIDDEN_CANARY</mtext>',
    '<mtext style="content-visibility:hidden">HIDDEN_CANARY</mtext>',
    '<mtext class="hide-canary">HIDDEN_CANARY</mtext>',
    '<mrow style="display:none"><mtext>HIDDEN_CANARY</mtext></mrow>',
    '<mrow style="visibility:hidden"><mtext style="visibility:visible">HIDDEN_CANARY</mtext></mrow>',
    '<mtext hidden>HIDDEN_CANARY</mtext>',
    '<mtext aria-hidden="true">HIDDEN_CANARY</mtext>',
  ];
  for (const hidden of hiddenCases) {
    const math = `<math><mi>x</mi>${hidden}<mo>+</mo><mn>1</mn></math>`;
    for (const formula of [math, `<span class="mwe-math-mathml-a11y" style="display:none">${math}</span>${renderedMath}`,
      `<span class="mwe-math-mathml-a11y" style="display:block;position:absolute;clip-path:inset(50%)">${math}</span>${lazyMath}`]) {
      reset(`<style>.hide-canary{display:none}</style><p>The formula is ${formula} in this example.</p>`);
      const ranges = collectRanges(document);
      check(ranges.length === 1 && ranges[0].source === 'The formula is x+1 in this example.'
        && ranges[0].protectedText?.length === 1 && ranges[0].protectedText[0].text === 'x+1'
        && ranges[0].translationSource === 'The formula is ⟪FOLIO:0⟫ in this example.', `hidden math leaked: ${hidden}`);
    }
  }
  return { name: 'paired-math-extraction', hiddenSubtreeCases: hiddenCases.length * 3, edgeAnchors: true, changedValues: true };
}

export async function pairedMathRegression() {
  const variants = [mathValue, pairedMath,
    (v: string) => pairedMath(v, 'display:block;position:absolute;width:1px;height:1px;clip-path:inset(50%)'),
    (v: string) => `<em>${pairedMath(v)}</em>`,
    (v: string) => pairedMath(v).replace('</span><mjx', '</span><!-- comment --><mjx'),
    (v: string) => pairedMath(v).replace(renderedMath, lazyMath)];
  for (const variant of variants) {
    reset(`<p>${formulaParagraph(variant)}</p>`);
    const ranges = collectRanges(document);
    check(ranges.length === 1 && ranges[0].source === formulaSource && ranges[0].translationSource === formulaMasked,
      `formula fragmented: ${JSON.stringify(ranges.map(r => r.source))}`);
    check(ranges[0].protectedText?.length === 2 && canHideRange(ranges[0]), 'formula protection or safe anchor lost');
  }
  for (const formula of [mathValue('block').replace('<math ', '<math display="block" '),
    pairedMath('block').replace('<math ', '<math display="block" '),
    pairedMath('block').replace('<mjx-container ', '<mjx-container display="true" ')]) {
    reset(`<p>Before the equation.${formula}After the equation.</p>`);
    check(JSON.stringify(collectRanges(document).map(r => r.source)) === JSON.stringify(['Before the equation.', 'After the equation.']),
      'display equation joined neighboring prose');
  }
  reset(`<p id="formula">${formulaParagraph()}</p><p id="control">An unchanged paragraph with <code>const  a = 1</code>, <kbd>Esc</kbd>,
    <samp>ok</samp>, <span role="math">x+1</span>, <span translate="no">Local Name</span>, <span class="notranslate">Other Name</span>
    and a <a href="#footnote">reference</a>.</p><p hidden>HIDDEN_CANARY</p>`);
  const paragraph = document.querySelector('#formula')!;
  const selection = getSelection()!;
  const selected = document.createRange(); selected.selectNodeContents(paragraph.firstChild!);
  selection.removeAllRanges(); selection.addRange(selected);
  const selectedText = selection.toString();
  const cache = new TranslationCache(); await cache.clear();
  const requests: string[] = [];
  let sequence = 0, invalid = '';
  const reuse = new TranslationReuse(cache, {
    async translate(request, progress) {
      requests.push(...request.blocks.map(b => b.text));
      check(request.blocks.every(b => !/CANARY|demb|dmodel|Local Name|const  a/.test(b.text)), 'protected value sent to provider');
      progress(request.blocks.map(b => ({ id: b.id, text: '预览 ' + b.text.slice(0, b.text.indexOf('⟪') + 5) })));
      check(outputs().every(e => !e.textContent?.includes('⟪')), 'partial token leaked');
      await delay(25);
      return request.blocks.map(b => ({ id: b.id, text: '译文 ' + (invalid === 'missing'
        ? b.text.replace('⟪FOLIO:0⟫', '') : invalid === 'duplicate' ? b.text + '⟪FOLIO:0⟫' : b.text) }));
    }, async cancel() {},
  });
  const engine = new PageTranslator(document, {
    async translate(jobId, settingsRevision, blocks, options) {
      const batchId = `math-${++sequence}`;
      const abort = () => reuse.cancelBatch(jobId, batchId);
      options?.signal?.addEventListener('abort', abort, { once: true });
      try { return { ok: true, result: await reuse.translate({ jobId, settingsRevision, batchId, blocks,
        origin: location.origin, url: location.href }, options?.onProgress) }; }
      catch (error) { return { ok: false, error: publicError(error) }; }
      finally { options?.signal?.removeEventListener('abort', abort); }
    }, async cancel(job) { reuse.cancelJob(job); },
  });
  try {
    engine.handle('start', 'paired', 'r1'); await engine.whenIdle();
    check(outputs(paragraph).length === 1 && outputs(paragraph)[0].textContent === '译文 ' + formulaSource, 'formula restoration failed');
    check(selection.toString() === selectedText, 'source selection changed');
    const control = outputs(document.querySelector('#control')!)[0];
    engine.setDisplayMode('translation-only');
    check([...paragraph.querySelectorAll('mjx-container')].every(e => getComputedStyle(e).display === 'none'), 'dangling rendered formula');
    check(getComputedStyle(document.querySelector('#control a')!).display !== 'none', 'interactive source hidden');
    engine.setDisplayMode('bilingual');
    check([...paragraph.querySelectorAll('mjx-container')].every(e => getComputedStyle(e).display !== 'none'), 'formula not restored');
    const before = requests.length;
    paragraph.querySelector('math')!.insertAdjacentHTML('beforeend', '<mtext style="display:none">HIDDEN_CANARY</mtext>');
    const canary = paragraph.querySelector('math')!.lastElementChild!;
    await engine.whenIdle();
    check(!outputs(paragraph)[0].textContent?.includes('HIDDEN_CANARY'), 'hidden addition changed formula output');
    canary.removeAttribute('style'); await engine.whenIdle();
    check(outputs(paragraph)[0].textContent?.includes('HIDDEN_CANARY'), 'revealed formula value was not restored');
    canary.setAttribute('style', 'visibility:hidden'); await engine.whenIdle();
    check(!outputs(paragraph)[0].textContent?.includes('HIDDEN_CANARY'), 'newly hidden formula value survived cache reuse');
    check(requests.length === before && control.isConnected, 'style change retransmitted unchanged masked input or paragraph');
    paragraph.querySelector('mtext')!.textContent = 'updated'; await engine.whenIdle();
    check(requests.length === before && outputs(paragraph)[0].textContent?.includes('dupdated'), 'cached mask used stale formula');
    check(control.isConnected, 'unchanged paragraph was rebuilt');
    // Equal replacement, insertion/removal and boundary attribute edits must re-read the mapping.
    const semantic = paragraph.querySelector('.mwe-math-mathml-a11y')!;
    semantic.replaceWith(semantic.cloneNode(true)); await engine.whenIdle();
    paragraph.insertAdjacentHTML('beforeend', ` A new value is ${pairedMath('added')}.`); await engine.whenIdle();
    check(outputs(paragraph).length === 1 && outputs(paragraph)[0].textContent?.includes('dadded'), 'inserted formula lost');
    const lastPair = [...paragraph.querySelectorAll('.mwe-math-mathml-a11y')].at(-1)!;
    lastPair.nextElementSibling!.remove(); lastPair.remove(); await engine.whenIdle();
    check(!outputs(paragraph)[0].textContent?.includes('dadded'), 'removed formula survived');
    const math = paragraph.querySelector('math')!;
    math.setAttribute('display', 'block'); await engine.whenIdle();
    check(outputs(paragraph).length === 2, 'display attribute mutation ignored');
    math.removeAttribute('display'); await engine.whenIdle();
    check(outputs(paragraph).length === 1 && control.isConnected, 'inline boundary not restored');
    engine.handle('stop'); await engine.whenIdle();
    check(outputs(paragraph).length === 1, 'stop removed completed paragraph');
    engine.handle('restore'); await engine.whenIdle();
    const repeat = requests.length;
    engine.handle('start', 'paired-reopen', 'r1'); await engine.whenIdle();
    check(requests.length === repeat, 'reopen did not reuse valid cache');
    engine.handle('restore'); await engine.whenIdle();
    // Invalid placeholders must fail both the page and persistent cache paths.
    for (const bad of ['missing', 'duplicate']) {
      reset(`<p>${formulaParagraph()}</p>`); await reuse.clear(); invalid = bad;
      engine.handle('start', 'invalid-' + bad, 'r1'); await engine.whenIdle();
      check(engine.getState().failed === 1 && outputs().length === 0, `${bad} placeholder accepted`);
      invalid = ''; const retryBefore = requests.length;
      engine.handle('retry', 'invalid-' + bad, 'r1'); await engine.whenIdle();
      check(requests.length === retryBefore + 1 && engine.getState().completed === 1, 'invalid result cached or retry failed');
      engine.handle('restore'); await engine.whenIdle();
    }
    // A fresh intact fixture verifies that Folio itself preserves every original node.
    reset(`<p>${formulaParagraph()}</p>`);
    const p = document.querySelector('p')!, nodes = [...p.childNodes], html = p.innerHTML;
    engine.handle('start', 'identity', 'r1'); await engine.whenIdle();
    engine.setDisplayMode('translation-only'); engine.handle('restore'); await engine.whenIdle();
    check(p.innerHTML === html && nodes.every((node, i) => p.childNodes[i] === node), 'original DOM changed');
    return { name: 'paired-math', staticVariants: variants.length, displayVariants: 3,
      nativeAndPaired: '1 range / 2 protected / 1 output', invalidPlaceholdersRejected: 2,
      cacheHitAdditionalCalls: 0, currentValueFromCachedMask: true, requests: requests.length };
  } finally { engine.dispose(); }
}

export async function pairedMathRaceRegression() {
  const observations = [];
  for (const phase of ['before', 'during', 'style-during', 'after', 'stop', 'restore']) {
    reset(`<p>${formulaParagraph(v => pairedMath(v).replace(renderedMath, lazyMath))}</p>`);
    if (phase === 'style-during') document.querySelector('math')!.insertAdjacentHTML('beforeend', '<mtext>HIDDEN_CANARY</mtext>');
    const pending: Array<() => void> = [];
    const engine = new PageTranslator(document, {
      async translate(_job, _revision, blocks, options) {
        const label = pending.length ? 'NEW ' : 'OLD ';
        return await new Promise(resolve => pending.push(() => {
          const result = blocks.map(b => ({ id: b.id, text: label + b.text }));
          options?.onProgress?.(result); resolve({ ok: true, result });
        }));
      }, async cancel() {},
    });
    const render = () => {
      for (const container of document.querySelectorAll('mjx-container')) {
        container.classList.add('MathJax');
        container.innerHTML = '<svg aria-hidden="true"><text>RENDER_ONLY_CANARY</text></svg>';
      }
    };
    try {
      if (phase === 'before') render();
      engine.handle('start', 'race-' + phase, 'r1');
      if (phase === 'after') { pending[0](); await engine.whenIdle(); }
      if (phase !== 'before') render();
      if (phase === 'during') document.querySelector('mtext')!.textContent = 'current';
      if (phase === 'style-during') document.querySelector('math')!.lastElementChild!.setAttribute('style', 'display:none');
      if (phase === 'stop' || phase === 'restore') engine.handle(phase);
      await delay(80);
      // Resolve the newer version before an uncooperative old provider replies.
      pending.slice(1).forEach(resolve => resolve()); pending[0]();
      await engine.whenIdle();
      if (phase === 'stop' || phase === 'restore') check(outputs().length === 0, 'late formula response after cancellation');
      else {
        check(outputs().length === 1, `${phase}: duplicated or missing output`);
        check(collectRanges(document)[0].protectedText?.length === 2, `${phase}: formula lost`);
        if (phase === 'during') check(outputs()[0].textContent?.includes('NEW ') && outputs()[0].textContent?.includes('dcurrent'), 'old response overwrote current formula');
        if (phase === 'style-during') check(outputs()[0].textContent === 'NEW ' + formulaSource, 'late response restored newly hidden formula text');
      }
      observations.push({ phase, requests: pending.length, outputs: outputs().length });
    } finally { engine.dispose(); }
  }
  return { name: 'paired-math-races', observations };
}
