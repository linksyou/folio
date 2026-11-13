import { chromium } from 'playwright';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const rounds = Number(process.env.FOLIO_BENCHMARK_ROUNDS ?? 30);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('FOLIO_BENCHMARK_ROUNDS must be 1..100');
// An exported baseline source tree can use exactly the same fixture and browser.
const source = resolve(process.env.FOLIO_BENCHMARK_SOURCE ?? '.');
const bundle = await build({ entryPoints: ['tests/browser/dynamic-harness.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'chrome120', plugins: [{ name: 'source-tree', setup(build) {
    build.onResolve({ filter: /\/src\/extension\/page\/PageTranslator\.js$/ }, () => ({ path: resolve(source, 'src/extension/page/PageTranslator.ts') }));
  } }] });
const browser = await chromium.launch({ channel: process.env.FOLIO_BROWSER_CHANNEL || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('https://folio.test/dynamic');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    samples.push(await page.evaluate(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([
        window.measureDynamic(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Dynamic benchmark timed out')), 10_000);
        }),
      ]); } finally { clearTimeout(timer); }
    }));
  }
  const times = samples.map(sample => Number(sample.durationMs)).sort((a, b) => a - b);
  const result = { browser: browser.version(), node: process.version, fixture: '1000 Chinese paragraphs; one substantial Text edit',
    scope: 'Discovery only, no provider; includes reconciliation but excludes debounce and mutation observer validation',
    samples, p50: times[Math.ceil(times.length * .5) - 1], p95: times[Math.ceil(times.length * .95) - 1] };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/performance-dynamic.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
