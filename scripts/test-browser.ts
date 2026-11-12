/** Isolated browser + real page pipeline/IndexedDB; synthetic provider, no accounts/network. */
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { summarizePerformance, aggregatePerformance } from '../src/shared/performance-report.js';

const benchmark = process.argv.includes('--benchmark');
const rounds = benchmark ? Number(process.env.FOLIO_BENCHMARK_ROUNDS ?? 5) : 1;
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('FOLIO_BENCHMARK_ROUNDS must be 1..100');
const bundle = await build({ entryPoints: ['tests/browser/page-harness.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'chrome120' });
const browser = await chromium.launch({ channel: process.env.FOLIO_BROWSER_CHANNEL || undefined });
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Browser scenario exceeded 15 seconds')), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}
const regressions = [];
const traces = [];
try {
  for (const name of benchmark ? [] : ['extraction', 'streaming', 'stop', 'dynamic', 'restore', 'fade-in',
    'protected-text', 'protected-failure', 'protection-toggle', 'literal-marker', 'incremental']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>' }));
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto('https://folio.test/article');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      regressions.push(await bounded(page.evaluate(name => window.folioTest.regression(name), name)));
      console.log(`PASS ${name}`);
    } finally { await context.close(); }
  }
  for (let round = 0; round < rounds; round++) {
    for (const scroll of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      try {
        await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>' }));
        const page = await context.newPage();
        await page.goto('https://folio.test/article');
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        traces.push(...await bounded(page.evaluate(scroll => window.folioTest.benchmark(scroll), scroll)));
      } finally { await context.close(); }
    }
  }
  const reports = traces.map(trace => summarizePerformance(trace));
  await mkdir('test-results', { recursive: true });
  const output = resolve('test-results', benchmark ? 'performance-browser.json' : 'browser-regressions.json');
  await writeFile(output, JSON.stringify({ schemaVersion: 1, recordedAt: new Date().toISOString(),
    environment: { node: process.version, browser: browser.version(), platform: process.platform,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) },
    scope: 'Real page module and IndexedDB in an isolated browser; provider has fixed mock delays. No extension messaging, Host, real model or network latency.',
    regressions, traces, reports, aggregate: aggregatePerformance(reports) }, null, 2) + '\n');
  console.log(`Saved ${output}`);
  console.log(JSON.stringify(aggregatePerformance(reports), null, 2));
} finally { await browser.close(); }
