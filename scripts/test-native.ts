/** Built Host + native framing + loopback HTTP/SSE. No installed browser profile or account. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeMessage, MessageDecoder } from '../src/host/framing.js';
import { EXTENSION_ID } from '../src/shared/extension-identity.js';
import type { HostCommand, HostStatus, NativeMessage, NativeProgress, NativeReply, SaveSettings } from '../src/shared/protocol.js';

const directory = await mkdtemp(join(tmpdir(), 'folio-native-test-'));
let receive!: (request: { response: ServerResponse; source: string }) => void;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let body = '';
    for await (const chunk of request) body += chunk;
    const value = JSON.parse(body);
    assert.equal(value.stream, true);
    receive({ response, source: value.messages[1].content });
  } catch { response.writeHead(500).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const host = spawn(process.execPath, ['dist/host/main.cjs', `chrome-extension://${EXTENSION_ID}/`], {
  env: { ...process.env, FOLIO_DATA_DIR: directory, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '*', no_proxy: '*' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const exited = once(host, 'exit');
const decoder = new MessageDecoder();
const waiting = new Map<string, (reply: NativeReply) => void>();
const progress: NativeProgress[] = [];
const progressWaiters = new Set<() => void>();
let sequence = 0;
let stderr = '';
host.stderr.on('data', chunk => { stderr += chunk; });
host.stdout.on('data', chunk => {
  for (const message of decoder.push(chunk) as NativeMessage[]) {
    if ('event' in message) {
      progress.push(message);
      for (const waiter of progressWaiters) waiter();
    } else { waiting.get(message.id)?.(message); waiting.delete(message.id); }
  }
});
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Native test exceeded 10 seconds')), 10_000);
  })]); } finally { clearTimeout(timer); }
}
function send(command: HostCommand) {
  const id = `native-${++sequence}`;
  const reply = new Promise<NativeReply>(resolve => waiting.set(id, resolve));
  host.stdin.write(encodeMessage({ id, command }));
  return { id, reply: bounded(reply) };
}
function waitProgress(id: string, predicate: (value: NativeProgress) => boolean) {
  let check: () => void;
  const promise = new Promise<void>(resolve => {
    check = () => { if (progress.some(value => value.id === id && predicate(value))) resolve(); };
    progressWaiters.add(check);
    check();
  });
  return bounded(promise).finally(() => progressWaiters.delete(check));
}
function nextRequest() { return bounded(new Promise<{ response: ServerResponse; source: string }>(resolve => { receive = resolve; })); }
function delta(response: ServerResponse, content: string, finish = false) {
  if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish ? 'stop' : null }] })}\n\n`);
  if (finish) response.end('data: [DONE]\n\n');
}
function status(reply: NativeReply): HostStatus { assert(reply.ok); return reply.result as HostStatus; }

try {
  const settings: SaveSettings = { provider: 'custom', customBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    customModel: 'fixture', chatgptModel: '', apiKey: 'native-fixture-only' };
  const initial = status(await send({ type: 'settings.save', settings }).reply);
  assert(!JSON.stringify(initial).includes('native-fixture-only'));
  const command: Extract<HostCommand, { type: 'translate' }> = { type: 'translate', jobId: 'first', batchId: 'batch',
    settingsRevision: initial.settingsRevision, blocks: [{ id: 'paragraph', text: 'Use ⟪FOLIO:0⟫ in this paragraph.' }], priority: 'visible' };
  const incoming = nextRequest();
  const first = send(command);
  const request = await incoming;
  assert.equal(request.source, command.blocks[0].text);
  delta(request.response, '译文 ');
  await waitProgress(first.id, () => true);
  const unchanged = status(await send({ type: 'settings.save', settings: { ...settings, chatgptModel: 'unused-model' } }).reply);
  assert.equal(unchanged.settingsRevision, initial.settingsRevision);
  delta(request.response, '⟪FOLIO:0⟫');
  await waitProgress(first.id, value => value.translations[0].text.includes('⟪FOLIO:0⟫'));
  delta(request.response, '。', true);
  const result = await first.reply;
  assert(result.ok);
  assert.deepEqual(result.result, [{ id: 'paragraph', text: '译文 ⟪FOLIO:0⟫。' }]);
  console.log('PASS native HTTP/SSE round trip and progress after inactive settings save');

  const invalidIncoming = nextRequest();
  const invalid = send({ ...command, jobId: 'invalid' });
  delta((await invalidIncoming).response, 'Dropped marker', true);
  const invalidReply = await invalid.reply;
  assert(!invalidReply.ok && invalidReply.error.code === 'INVALID_RESPONSE');
  console.log('PASS native rejects missing protected marker');

  const cancelledIncoming = nextRequest();
  const cancelled = send({ ...command, jobId: 'cancelled' });
  const cancelledRequest = await cancelledIncoming;
  delta(cancelledRequest.response, 'Pending');
  await waitProgress(cancelled.id, () => true);
  const changed = status(await send({ type: 'settings.save', settings: { ...settings, customModel: 'next-model' } }).reply);
  assert.notEqual(changed.settingsRevision, initial.settingsRevision);
  const cancelledReply = await cancelled.reply;
  assert(!cancelledReply.ok && cancelledReply.error.code === 'CANCELLED');
  delta(cancelledRequest.response, '⟪FOLIO:0⟫ late', true);
  await send({ type: 'status' }).reply;
  assert(!progress.filter(value => value.id === cancelled.id).some(value => value.translations[0].text.includes('late')));
  console.log('PASS active settings change cancels native stream and suppresses late output');
} finally {
  host.stdin.end();
  await bounded(exited);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
assert.equal(host.exitCode, 0, stderr);
