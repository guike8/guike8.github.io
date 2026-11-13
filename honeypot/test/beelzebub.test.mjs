import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBeelzebubAdapter, createBoundedLineDecoder, normalizeBeelzebubEvent, MAX_LINE_BYTES } from '../adapters/beelzebub.mjs';
import { childEnvironment, superviseBeelzebub } from '../adapters/run-beelzebub.mjs';
import { createRotatingLog } from '../web/log.mjs';

// Exact field capitalization/envelope from pinned upstream v3.10.0 tracer and
// standardOutStrategy; sensitive values below are inert test sentinels only.
function trace(fields = {}) {
  return {
    level: 'info', msg: 'New Event', status: 'Stateless', time: '2026-11-13T12:00:00Z',
    event: {
      DateTime: '2026-11-13T12:00:00Z', RemoteAddr: '203.0.113.4', Protocol: 'HTTP',
      Status: 'Stateless', Msg: 'HTTP New request', ID: '3722df77-4a8c-4510-900b-d9f946349338',
      HTTPMethod: 'POST', RequestURI: '/admin/session?token=private-query', Handler: 'authentication:303',
      SourceIp: '203.0.113.4', SourcePort: '', UserAgent: 'scanner/1.0 password=private-agent Bearer private-bearer',
      Body: 'username=person&password=private-body', Cookies: 'session=private-cookie',
      Headers: '[Key: Authorization, values: Bearer private-auth],', Password: 'private-password',
      HeadersMap: { Authorization: ['Bearer private-auth'], Cookie: ['session=private-cookie'], 'X-Nightjar-Source': ['198.51.100.7'], 'X-Forwarded-For': ['192.0.2.33'] },
      Metadata: { token: 'private-metadata' }, CommandOutput: 'private-output', ...fields,
    },
  };
}

test('pinned Beelzebub tracer fields normalize through a strict privacy whitelist', () => {
  const event = normalizeBeelzebubEvent(trace(), { now: Date.parse('2026-11-13T12:00:00Z'), trustedProxy: true });
  assert.deepEqual(Object.keys(event), ['id', 'timestamp', 'protocol', 'event', 'source_ip', 'method', 'path', 'category', 'status', 'user_agent', 'detail']);
  assert.equal(event.source_ip, '203.0.113.4'); // Native validated peer wins over any header.
  assert.equal(event.path, '/admin/session');
  assert.equal(event.status, 303);
  assert.equal(event.category, 'authentication');
  assert.equal(event.detail, 'Beelzebub HTTP request');
  assert.equal(event.user_agent, 'scanner/1.0 password=[redacted] Bearer [redacted]');
  assert.doesNotMatch(JSON.stringify(event), /private-|person|Headers|Cookies|Password|Metadata|CommandOutput/);
});

test('source fallback requires explicit trusted ingress and rejects duplicate or malformed headers', () => {
  const raw = trace({ SourceIp: 'invalid' });
  assert.equal(normalizeBeelzebubEvent(raw).source_ip, 'unknown');
  assert.equal(normalizeBeelzebubEvent(raw, { trustedProxy: true }).source_ip, '198.51.100.7');
  raw.event.HeadersMap['X-Nightjar-Source'] = ['198.51.100.7', '192.0.2.99'];
  assert.equal(normalizeBeelzebubEvent(raw, { trustedProxy: true }).source_ip, 'unknown');
  raw.event.HeadersMap = { 'X-Nightjar-Source': ['198.51.100.7'], 'x-nightjar-source': ['192.0.2.99'] };
  assert.equal(normalizeBeelzebubEvent(raw, { trustedProxy: true }).source_ip, 'unknown');
});

test('request targets, agent secrets, status and timestamps remain bounded and truthful', () => {
  const event = normalizeBeelzebubEvent(trace({
    RequestURI: '/.env%3Fpassword%3Dencoded-path-secret',
    UserAgent: 'probe token%3Dencoded-agent-secret ' + 'a'.repeat(1000),
    Handler: 'unexpected-handler-secret', Status: 599, DateTime: '9999-01-01T00:00:00Z', ID: 'not-a-uuid-secret',
  }), { now: Date.parse('2026-11-13T12:00:00Z') });
  assert.equal(event.path, '/.env');
  assert.equal(event.category, 'reconnaissance');
  assert.equal(event.status, null);
  assert.equal(event.timestamp, '2026-11-13T12:00:00.000Z');
  assert.match(event.id, /^[a-f0-9-]{36}$/);
  assert.ok(event.user_agent.length <= 256);
  assert.doesNotMatch(JSON.stringify(event), /encoded-path-secret|encoded-agent-secret|unexpected-handler-secret|not-a-uuid-secret/);
  assert.equal(normalizeBeelzebubEvent(trace({ Handler: '' })).status, 405);
  assert.equal(normalizeBeelzebubEvent(trace({ RequestURI: '/cgi-bin/../etc/passwd', Handler: 'discovery:404' })).category, 'exploitation');
  assert.equal(normalizeBeelzebubEvent(trace({ RequestURI: '/index.html%25253Fsearch%253Dprivate-encoded-query' })).path, '/index.html');
});

test('diagnostic prefixes, nested JSON messages, non-HTTP traces and incomplete lines are never events', () => {
  const events = [], diagnostics = [];
  const adapter = createBeelzebubAdapter({ emit: event => events.push(event), diagnostic: code => diagnostics.push(code) });
  adapter.write(Buffer.from(`startup prefix ${JSON.stringify(trace())}\n`));
  adapter.write(Buffer.from(JSON.stringify({ msg: JSON.stringify(trace()) }) + '\n'));
  adapter.write(Buffer.from(JSON.stringify(trace({ Protocol: 'SSH' })) + '\n'));
  adapter.write(Buffer.from(JSON.stringify(trace()))); // Incomplete physical line is discarded.
  adapter.end();
  assert.equal(events.length, 0);
  assert.ok(diagnostics.length >= 4);
  assert.ok(diagnostics.every(code => code === 'suppressed'));
});

test('line input is capped at 64KiB, discards entire oversized records and resynchronizes', () => {
  const lines = [], discards = [];
  const decoder = createBoundedLineDecoder({ onLine: line => lines.push(line), onDiscard: reason => discards.push(reason) });
  decoder.write(Buffer.alloc(MAX_LINE_BYTES, 97));
  assert.equal(decoder.bufferedBytes, MAX_LINE_BYTES);
  decoder.write(Buffer.from('secret-tail'));
  assert.equal(decoder.bufferedBytes, 0);
  decoder.write(Buffer.from('still-secret\n{"safe":true}\n'));
  assert.deepEqual(lines, ['{"safe":true}']);
  assert.deepEqual(discards, ['oversized']);
  decoder.write(Buffer.alloc(1024 * 1024, 98));
  assert.ok(decoder.bufferedBytes <= MAX_LINE_BYTES);
  decoder.end();
});

test('split UTF-8 JSON records reach only the normalized rotating spool', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightjar-beel-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = createRotatingLog(path.join(directory, 'events.json'));
  const adapter = createBeelzebubAdapter({ emit: event => log.emit(event) });
  const bytes = Buffer.from(JSON.stringify(trace({ UserAgent: 'probe ㇏(•̀ᵥᵥ•́)ノ token=private-utf8-agent' })) + '\n');
  for (let i = 0; i < bytes.length; i += 3) adapter.write(bytes.subarray(i, i + 3));
  adapter.end(); log.close();
  const persisted = fs.readFileSync(path.join(directory, 'events.json'), 'utf8');
  const event = JSON.parse(persisted);
  assert.match(event.user_agent, /㇏/);
  assert.doesNotMatch(persisted, /private-|Body|HeadersMap|Cookies|Password/);
  assert.equal(event.detail, 'Beelzebub HTTP request');
});

test('the supervisor drains both child pipes, drops raw stderr and exposes no payload diagnostics', async () => {
  const events = [], diagnostics = [];
  const program = `process.stdout.write(${JSON.stringify(JSON.stringify(trace()) + '\n')}); process.stderr.write('private-stderr-password\\n'); process.stdout.write('private-stdout-diagnostic\\n');`;
  const runtime = superviseBeelzebub({ binary: process.execPath, args: ['-e', program], emit: event => events.push(event), diagnostic: code => diagnostics.push(code) });
  const result = await runtime.done;
  assert.equal(result.code, 0);
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify({ events, diagnostics }), /private-/);
  assert.ok(diagnostics.every(code => code === 'suppressed'));
  const env = childEnvironment();
  assert.equal(env.BEELZEBUB_CLOUD_ENABLED, 'false');
  assert.equal(env.BEELZEBUB_RABBITMQ_ENABLED, 'false');
  assert.equal(env.BEELZEBUB_LOGGING_LOGS_PATH, '');
  assert.ok(!Object.hasOwn(env, 'OPENAI_API_KEY'));
  assert.ok(!Object.hasOwn(env, 'CONSOLE_TOKEN'));
});

test('runtime spawn failures emit fixed codes without command details', async () => {
  const diagnostics = [];
  const runtime = superviseBeelzebub({ binary: '/missing/private-binary-secret', diagnostic: code => diagnostics.push(code) });
  const result = await runtime.done;
  assert.equal(result.code, 1);
  assert.ok(diagnostics.includes('runtime'));
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-binary-secret/);
});
