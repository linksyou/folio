import { PageTranslator, type TranslationTransport } from '../../src/extension/page/PageTranslator.js';
import { collectRanges } from '../../src/extension/page/extract.js';
import { TranslationCache } from '../../src/extension/translation-cache.js';
import { TranslationReuse } from '../../src/extension/translation-reuse.js';
import { publicError } from '../../src/shared/errors.js';

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
            origin: 'https://folio.test', url: 'https://folio.test/article' }, options?.onProgress) };
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
