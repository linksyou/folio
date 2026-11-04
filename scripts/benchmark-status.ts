/** Real AuthStore filesystem contention and HostService read counts; isolated empty state. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ChatGPTAuth } from '../src/host/auth/index.js';
import { HostService } from '../src/host/service.js';
import { SettingsStore } from '../src/host/settings.js';

const rounds = Number(process.env.FOLIO_BENCHMARK_ROUNDS ?? 10);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('FOLIO_BENCHMARK_ROUNDS must be 1..100');
const directory = await mkdtemp(join(tmpdir(), 'folio-status-benchmark-'));
try {
  const auth = new ChatGPTAuth({ dataDir: directory, fetch: async () => { throw new Error('Network forbidden in benchmark'); } });
  const rows: Array<{ concurrency: number; round: number; totalMs: number }> = [];
  await auth.status();
  for (const concurrency of [1, 2, 6]) {
    for (let round = 0; round < rounds; round++) {
      const start = performance.now();
      const results = await Promise.all(Array.from({ length: concurrency }, () => auth.status()));
      assert(results.every(status => status.state === 'signed_out'));
      rows.push({ concurrency, round, totalMs: Math.round((performance.now() - start) * 100) / 100 });
    }
  }
  const groups = [1, 2, 6].map(concurrency => {
    const sorted = rows.filter(r => r.concurrency === concurrency).map(r => r.totalMs).sort((a, b) => a - b);
    return { concurrency, n: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
  });
  const store = new SettingsStore(directory);
  await store.save({ provider: 'custom', customBaseUrl: 'https://example.invalid/v1', customModel: 'mock', chatgptModel: '' });
  let settingsReads = 0, authReads = 0;
  const read = store.read.bind(store), status = auth.status.bind(auth);
  store.read = async () => { settingsReads++; return read(); };
  auth.status = async () => { authReads++; return status(); };
  // The provider is an intentional local stub; no request can reach example.invalid.
  const service = new HostService(store, auth, { translate: async (_settings: unknown, blocks: { id: string; text: string }[]) => blocks.map(b => ({ id: b.id, text: '译文' })) } as never);
  let calls;
  try {
    const initial = await service.status();
    settingsReads = authReads = 0;
    await service.handle({ type: 'translate', jobId: 'benchmark', batchId: 'batch', settingsRevision: initial.settingsRevision,
      blocks: [{ id: 'sample', text: 'A public benchmark paragraph.' }] });
    calls = { settingsReads, authReads };
  } finally { service.close(); }
  const result = { schemaVersion: 1, recordedAt: new Date().toISOString(), scope: 'Real filesystem, isolated empty auth; injected provider; excludes browser/native messaging/model/network',
    node: process.version, platform: process.platform,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), rows, groups, hostBatch: calls };
  await mkdir('test-results', { recursive: true });
  const output = resolve('test-results/performance-status.json');
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ groups, hostBatch: calls, output }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
