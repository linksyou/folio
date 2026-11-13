import { PageTranslator, type TranslationTransport } from '../../src/extension/page/PageTranslator.js';
import { collectRanges } from '../../src/extension/page/extract.js';
import { TranslationCache } from '../../src/extension/translation-cache.js';
import { TranslationReuse } from '../../src/extension/translation-reuse.js';
import { publicError } from '../../src/shared/errors.js';
import { pairedMathExtractionRegression, pairedMathRegression, pairedMathRaceRegression } from './paired-math.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const sample = 'A public sample paragraph explains how readers find useful information on a page.';
function reset(html: string) {
  document.body.innerHTML = html;
  document.documentElement.style.scrollBehavior = 'auto';
  window.scrollTo(0, 0);
}
function translator(transport: TranslationTransport) {
  return new PageTranslator(document, transport, { getUrl: () => 'https://folio.test/article' });
}
const outputs = () => Array.from(document.querySelectorAll('[data-folio="translation"]'), e => e.textContent ?? '');

async function regression(name: string) {
  if (name === 'paired-math-extraction') return pairedMathExtractionRegression();
  if (name === 'paired-math') return pairedMathRegression();
  if (name === 'paired-math-races') return pairedMathRaceRegression();
  if (name === 'retry-new-job') {
    reset(`<main><p>${sample}</p></main>`);
    const jobs: string[] = [];
    const engine = translator({
      async translate(jobId, _revision, blocks, options) {
        jobs.push(jobId);
        await delay(jobId === 'old-job' ? 100 : 20);
        const result = blocks.map(block => ({ id: block.id, text: `${jobId} 译文` }));
        options?.onProgress?.(result);
        return { ok: true, result };
      },
      async cancel() {},
    });
    try {
      engine.handle('start', 'old-job', 'r1');
      engine.handle('retry', 'old-job', 'r1');
      check(jobs.length === 1, 'identical command created duplicate work');
      engine.handle('retry', 'new-job', 'r1');
      await engine.whenIdle();
      await delay(120);
      check(jobs.join(',') === 'old-job,new-job', 'new route did not take over');
      check(outputs().length === 1 && outputs()[0] === 'new-job 译文', 'old route wrote back after retry');
      return { name, jobs, state: engine.getState() };
    } finally { engine.dispose(); }
  }
  if (name === 'cache-capacity') return cacheCapacityRegression();
  if (name === 'literal-marker') {
    const source = `An unusual literal ⟪FOLIO:${'1'.repeat(2000)}⟫ is still ordinary source text.`;
    reset(`<main><p>${source}</p></main>`);
    const engine = translator({ async translate(_job, _revision, blocks) {
      return { ok: true, result: blocks.map(b => ({ id: b.id, text: b.text })) };
    }, async cancel() {} });
    try {
      engine.handle('start', name, 'r1');
      await engine.whenIdle();
      check(engine.getState().completed === 1 && outputs()[0] === source, 'long literal marker broke chunking');
      return { name, state: engine.getState() };
    } finally { engine.dispose(); }
  }
  if (['protected-text', 'protected-failure', 'protection-toggle', 'incremental'].includes(name)) return qualityRegression(name);
  if (name === 'extraction') {
    // Fixtures are also exercised by the Node suite; this path uses real CSS/layout.
    const { extractionCases } = await import('../fixtures/extraction.js');
    const observations = [];
    for (const fixture of extractionCases) {
      reset(fixture.html);
      const actual = collectRanges(document).map(range => range.source);
      check(JSON.stringify(actual) === JSON.stringify(fixture.expected), `${fixture.name}: ${JSON.stringify(actual)}`);
      observations.push({ name: fixture.name, actual });
    }
    return observations;
  }
  reset(`<main><p>${sample}</p></main>`);
  if (name === 'fade-in') {
    document.body.insertAdjacentHTML('afterbegin', '<style>@keyframes folio-test-fade { from { opacity:0 } to { opacity:1 } } p { animation:folio-test-fade 40ms linear 100ms both }</style>');
  }
  let calls = 0;
  let sawPartial = false;
  const engine = translator({
    async translate(_job, _revision, blocks, options) {
      calls++;
      // Deliberately ignores AbortSignal: stale callbacks must still be rejected.
      await delay(20);
      options?.onProgress?.(blocks.map(b => ({ id: b.id, text: `预览：${b.text}` })));
      sawPartial ||= outputs().some(text => text.startsWith('预览：'));
      await delay(25);
      return { ok: true, result: blocks.map(b => ({ id: b.id, text: `译文：${b.text}` })) };
    },
    async cancel() {},
  });
  try {
    engine.handle('start', `regression-${name}`, 'r1');
    if (name === 'fade-in') {
      check(engine.getState().total === 0, 'fixture must initially be transparent');
      for (let attempts = 0; attempts < 100 && engine.getState().completed === 0; attempts++) await delay(20);
      check(engine.getState().completed === 1, 'CSS-only fade-in was never discovered');
    }
    if (name === 'stop') {
      engine.handle('stop');
      await delay(90);
      check(outputs().length === 0, 'late progress/result written after stop');
      check(engine.getState().status === 'stopped', 'stopped state lost');
    } else if (name === 'dynamic') {
      document.querySelector('p')!.firstChild!.textContent = 'A replacement paragraph should receive only its own translated result.';
      await delay(160);
      await engine.whenIdle();
      check(outputs().length === 1 && outputs()[0].includes('replacement paragraph'), 'replacement was not translated');
      check(!outputs()[0].includes(sample), 'obsolete source was written back');
    } else {
      await engine.whenIdle();
      check(sawPartial, 'stream preview missing');
      check(engine.getState().completed === 1 && outputs().length === 1, 'translation incomplete or duplicated');
      const before = calls;
      await delay(80);
      check(calls === before, 'own output triggered duplicate translation');
      if (name === 'restore') {
        engine.handle('restore');
        await engine.whenIdle();
        check(outputs().length === 0 && document.querySelector('p')!.textContent === sample, 'restore damaged original');
      }
    }
    const endings = engine.getDiagnostics().filter(event => event.stage === 'session.end');
    check(endings.length === 1, 'initial pass must have exactly one terminal event');
    check(endings[0].values?.success === (name !== 'stop'), 'terminal success flag is incorrect');
    return { name, calls, state: engine.getState(), events: engine.getDiagnostics() };
  } finally { engine.dispose(); }
}

async function qualityRegression(name: string) {
  const incremental = name === 'incremental';
  reset(incremental
    ? `<main>${Array.from({ length: 300 }, (_, i) => `<p>${i}. ${sample.repeat(2)}</p>`).join('')}</main>`
    : `<main><p>${'A'.repeat(1497)}<code>const  secret = 42;</code> preserves code. <span translate="no">Local Product</span> uses <math><mi>x</mi><mo>+</mo><mn>1</mn></math> in this explanation.</p></main>`);
  const paragraph = document.querySelector('p')!;
  const originalNodes = [...paragraph.childNodes];
  const original = paragraph.textContent;
  const sent: string[] = [];
  const engine = translator({
    async translate(_job, _revision, blocks, options) {
      sent.push(...blocks.map(b => b.text));
      for (const block of blocks) {
        check(!block.text.includes('secret') && !block.text.includes('Local Product'), 'protected value left the page');
        const start = block.text.indexOf('⟪');
        if (start >= 0) {
          check(/⟪FOLIO:\d+⟫/.test(block.text), 'chunk split a marker');
          options?.onProgress?.([{ id: block.id, text: block.text.slice(0, start + 4) }]);
          check(outputs().every(text => !text.includes('⟪')), 'partial marker was rendered');
        }
      }
      if (name === 'protection-toggle') await delay(40);
      const result = blocks.map(b => ({ id: b.id, text: `译文 ${b.text}` }));
      options?.onProgress?.(result);
      return { ok: true, result: name === 'protected-failure'
        ? result.map(b => ({ ...b, text: b.text.replace(/⟪FOLIO:\d+⟫/gu, '') })) : result };
    },
    async cancel() {},
  });
  try {
    engine.handle('start', `quality-${name}`, 'r1');
    if (name === 'protection-toggle') {
      paragraph.setAttribute('translate', 'no');
      await delay(140);
      await engine.whenIdle();
      check(outputs().length === 0, 'late output survived translate=no');
      paragraph.setAttribute('translate', 'yes');
      await delay(80);
    }
    await engine.whenIdle();
    if (name === 'protected-failure') {
      check(engine.getState().failed === 1 && outputs().length === 0, 'invalid marker output was accepted');
    } else if (incremental) {
      const before = sent.length;
      paragraph.firstChild!.textContent = `Changed paragraph. ${sample.repeat(2)}`;
      await engine.whenIdle();
      check(sent.length === before + 1, 'text edit retransmitted unchanged paragraphs');
      const event = engine.getDiagnostics().filter(e => e.stage === 'extraction.dynamic').at(-1);
      check(event?.values?.incremental === true && event.values.candidates === 1, 'text edit rescanned document');
      check(engine.getState().completed === 300 && outputs().length === 300, 'incremental edit lost paragraphs');
      // Structural edits can change the selected content root; must use full discovery.
      document.querySelector('main')!.innerHTML = `<article><p>${sample.repeat(2)}</p></article>`;
      await engine.whenIdle();
      check(engine.getState().total === 1 && outputs().length === 1, 'replaced root retained stale paragraphs');
      check(engine.getDiagnostics().filter(e => e.stage === 'extraction.dynamic').at(-1)?.values?.incremental === false, 'scope edit did not rescan');
    } else {
      check(outputs().length === 1 && outputs()[0].includes('const  secret = 42;')
        && outputs()[0].includes('Local Product') && outputs()[0].includes('x+1'), `protected values were lost: ${JSON.stringify({ state: engine.getState(), outputs: outputs().map(text => text.slice(-200)), sent: sent.map(text => text.slice(-200)) })}`);
      check(!outputs()[0].includes('⟪FOLIO:'), 'opaque markers leaked');
      engine.setDisplayMode('translation-only');
      engine.handle('restore');
      await engine.whenIdle();
      check(paragraph.textContent === original && originalNodes.every((node, i) => paragraph.childNodes[i] === node), 'restore changed source nodes');
    }
    return { name, sourceChunks: sent.length, state: engine.getState(), events: engine.getDiagnostics() };
  } finally { engine.dispose(); }
}

async function cacheCapacityRegression() {
  const cache = new TranslationCache();
  await cache.clear();
  let providerCalls = 0;
  let unavailable = false;
  const reuse = new TranslationReuse(cache, {
    async translate(request) {
      providerCalls++;
      if (unavailable) throw new Error('Fixture provider unavailable');
      return request.blocks.map(b => ({ id: b.id, text: `译文 ${b.text}` }));
    },
    cancel() {},
  });
  let sequence = 0;
  const translate = (ids: number[]) => reuse.translate({
    jobId: 'cache-capacity', batchId: String(++sequence), settingsRevision: 'r1',
    origin: 'https://folio.test', url: 'https://folio.test/article',
    blocks: ids.map(id => ({ id: String(id), text: `Paragraph ${id}. ${sample}` })),
  });
  await translate(Array.from({ length: 257 }, (_, i) => i));
  await translate(Array.from({ length: 256 }, (_, i) => i));
  check(providerCalls === 1, 'cache warmup repeated provider work');
  providerCalls = 0;
  unavailable = true;
  const requested = [256, 0, 1];
  const translations = await translate(requested);
  check(JSON.stringify(translations) === JSON.stringify(requested.map(id => ({
    id: String(id), text: `译文 Paragraph ${id}. ${sample}`,
  }))), 'mixed cache hits were lost or reordered');
  check(providerCalls === 0, 'fully cached batch reached the unavailable provider');
  const stats = await cache.stats();
  check(stats.entries === 257, 'IndexedDB did not retain all fixture translations');
  return { name: 'cache-capacity', cacheStore: 'IndexedDB', entries: stats.entries, providerCalls, translations };
}

async function benchmark(scroll: boolean) {
  reset(`<main>${Array.from({ length: 12 }, (_, i) => `<p style="min-height:220px; margin:0 0 12px">Paragraph ${i + 1}. ${sample.repeat(9)}</p>`).join('')}</main>`);
  const cache = new TranslationCache();
  await cache.clear();
  let providerCalls = 0;
  let sequence = 0;
  const reuse = new TranslationReuse(cache, {
    async translate(request, progress) {
      providerCalls++;
      await delay(12);
      progress(request.blocks.map(b => ({ id: b.id, text: `预览 ${b.text.slice(0, 45)}` })));
      await delay(13);
      return request.blocks.map(b => ({ id: b.id, text: `译文 ${b.text.slice(0, 45)}` }));
    },
    cancel() {},
  });
  const traces = [];
  for (const cacheMode of ['miss', 'hit'] as const) {
    window.scrollTo(0, 0);
    // Deliver the previous scroll reset before a new job starts observing it.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const before = providerCalls;
    const engine = translator({
      async translate(jobId, settingsRevision, blocks, options) {
        const batchId = `batch-${++sequence}`;
        const abort = () => reuse.cancelBatch(jobId, batchId);
        options?.signal?.addEventListener('abort', abort, { once: true });
        try {
          if (options?.signal?.aborted) return { ok: false, error: { code: 'CANCELLED', message: 'cancelled' } };
          return { ok: true, result: await reuse.translate({ jobId, batchId, settingsRevision, blocks,
            origin: 'https://folio.test', url: 'https://folio.test/article', priority: options?.priority }, options?.onProgress) };
        } catch (error) { return { ok: false, error: publicError(error) }; }
        finally { options?.signal?.removeEventListener('abort', abort); }
      },
      async cancel(jobId) { reuse.cancelJob(jobId); },
    });
    try {
      engine.handle('start', `benchmark-${cacheMode}`, 'r1');
      if (scroll) {
        await delay(70);
        window.scrollTo(0, 1750);
        document.dispatchEvent(new Event('scroll'));
      }
      await engine.whenIdle();
      await delay(80); // Include the coalesced reading cohort after a scroll.
      await engine.whenIdle();
      check(engine.getState().completed === 12, `benchmark not complete: ${JSON.stringify(engine.getState())}`);
      const endings = engine.getDiagnostics().filter(event => event.stage === 'session.end');
      check(endings.length === 1 && endings[0].values?.success === true && endings[0].values?.completed === 12, 'benchmark terminal diagnostics incorrect');
      const requested = providerCalls - before;
      check(cacheMode === 'hit' ? requested === 0 : requested > 0, `unexpected ${cacheMode} provider calls: ${requested}`);
      traces.push({ conditions: { scenarioId: scroll ? 'scroll-12-paragraphs' : 'static-12-paragraphs',
        source: 'mock' as const, connection: 'unknown' as const, cache: cacheMode },
        page: engine.getDiagnostics(), background: [], host: [], providerCalls: requested,
        fixture: { blocks: 12, mockFirstChunkMs: 12, mockCompletionMs: 25, cacheStore: 'IndexedDB' } });
      engine.handle('restore');
      await engine.whenIdle();
    } finally { engine.dispose(); }
  }
  return traces;
}

declare global { interface Window { folioTest: { regression: typeof regression; benchmark: typeof benchmark } } }
window.folioTest = { regression, benchmark };
