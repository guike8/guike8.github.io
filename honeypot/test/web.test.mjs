import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecoyServer, MAX_BODY_BYTES } from '../web/server.mjs';
import { createRotatingLog } from '../web/log.mjs';
import { createQuarantine, QuarantineError } from '../web/quarantine.mjs';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

async function setup(t, options = {}) {
  const events = [];
  const server = createDecoyServer({ emit: event => events.push(event), clock: () => new Date('2026-11-11T12:00:00Z'), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeClients(); await new Promise(resolve => server.close(resolve)); });
  return { events, server, port: server.address().port, base: `http://127.0.0.1:${server.address().port}` };
}
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('decoy breadcrumbs lead to coherent synthetic configuration and archives', async t => {
  const { port, events } = await setup(t);
  const home = await request(port);
  assert.equal(home.status, 200);
  assert.match(home.body, /staging-02/);
  assert.match(home.body, /\/backup\/staging-02\.sql/);
  const env = await request(port, { path: '/.env' });
  assert.match(env.body, /DB_PASSWORD=stg_arch_/);
  assert.match(env.body, /APP_HOST=staging-02/);
  const git = await request(port, { path: '/.git/config' });
  assert.match(git.body, /example\.invalid/);
  const backup = await request(port, { path: '/backup/staging-02.sql' });
  assert.match(backup.body, /INSERT INTO archive_jobs/);
  assert.equal(events.length, 4);
  assert.equal(events[1].category, 'reconnaissance');
  assert.equal(events[1].timestamp, '2026-11-11T12:00:00.000Z');
});

test('authentication submissions are discarded and secrets never enter telemetry or responses', async t => {
  const { port, events } = await setup(t);
  const body = 'username=private-person&password=SUPER-SECRET-PASSWORD&token=token-body-value';
  const response = await request(port, { method: 'POST', path: '/admin/session?token=QUERY-SECRET', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body),
    Authorization: 'Bearer AUTH-SECRET', Cookie: 'session=COOKIE-SECRET',
    'X-Forwarded-For': '203.0.113.37',
  }, body });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/admin/unavailable');
  assert.equal(events.length, 1);
  assert.equal(events[0].category, 'authentication');
  assert.equal(events[0].path, '/admin/session');
  assert.equal(events[0].source_ip, '127.0.0.1');
  const captured = JSON.stringify(events) + response.body + JSON.stringify(response.headers);
  for (const secret of ['SUPER-SECRET-PASSWORD', 'QUERY-SECRET', 'AUTH-SECRET', 'COOKIE-SECRET', 'private-person', 'token-body-value']) assert.ok(!captured.includes(secret));
});


test('credential-looking path and agent assignments are redacted before source logging', async t => {
  const { port, events } = await setup(t);
  await request(port, { path: '/admin/password%3Durl-secret?token=ignored-query-secret', headers: { 'User-Agent': 'probe/1.0 Bearer bearer-secret token=agent-secret' } });
  const captured = JSON.stringify(events);
  for (const secret of ['url-secret', 'ignored-query-secret', 'bearer-secret', 'agent-secret']) assert.ok(!captured.includes(secret));
  assert.match(events[0].path, /password=\[redacted\]/);
  assert.match(events[0].user_agent, /Bearer \[redacted\]/);
});

test('HEAD sends metadata without a body and API decoys do not reflect query input', async t => {
  const { port, events } = await setup(t);
  const get = await request(port, { path: '/api/status' });
  const head = await request(port, { method: 'HEAD', path: '/api/status' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  const unknown = await request(port, { path: '/api/missing?value=%3Cscript%3Ealert(1)%3C/script%3E' });
  assert.equal(unknown.status, 404);
  assert.ok(!unknown.body.includes('<script>'));
  assert.equal(events[2].path, '/api/missing');
  assert.equal(events[2].category, 'exploitation');
  assert.match(unknown.headers['content-security-policy'], /default-src 'none'/);
});

test('malformed percent encodings return a bounded 400 without reflecting request text', async t => {
  const { port, events } = await setup(t);
  const response = await request(port, { path: '/%ZZ/%3Cscript%3E' });
  assert.equal(response.status, 400);
  assert.ok(!response.body.includes('%ZZ'));
  assert.equal(events[0].detail, 'Malformed request target');
  assert.ok(events[0].path.length <= 256);
});

test('oversized declared or streamed bodies and oversized URLs are bounded', async t => {
  const { port, events } = await setup(t);
  const declared = await request(port, { method: 'POST', path: '/admin/session', headers: { 'Content-Length': MAX_BODY_BYTES + 1 } });
  assert.equal(declared.status, 413);
  const streamed = await request(port, { method: 'POST', path: '/admin/session', body: 's'.repeat(MAX_BODY_BYTES + 1) });
  assert.equal(streamed.status, 413);
  const url = await request(port, { path: '/' + 'a'.repeat(4100) });
  assert.equal(url.status, 414);
  assert.equal(events[2].path, '[oversized-url]');
  assert.ok(JSON.stringify(events).length < 4096);
});

test('user-agent metadata is bounded and parser errors cannot become reflected data', async t => {
  const { port, events } = await setup(t);
  await request(port, { path: '/cgi-bin/../../etc/passwd', headers: { 'User-Agent': 'x'.repeat(1024) } });
  assert.equal(events[0].category, 'exploitation');
  assert.equal(events[0].user_agent.length, 256);
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nBad Header: secret-reflection\r\n\r\n'));
    let data = '';
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 400/);
  assert.ok(!response.includes('secret-reflection'));
  assert.equal(events.length, 1);
});

test('telemetry rotation caps disk usage, preserves valid JSON and rejects oversized events', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'honeypot-web-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'events.json');
  let errors = 0;
  const log = createRotatingLog(filename, { maxBytes: 1024, files: 3, onError: () => errors++ });
  for (let i = 0; i < 60; i++) log.emit({ id: i, detail: 'a'.repeat(200) });
  log.emit({ detail: 'x'.repeat(5000) });
  log.close();
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 3);
  for (const name of files) {
    const content = fs.readFileSync(path.join(directory, name), 'utf8');
    assert.ok(Buffer.byteLength(content) <= 1024);
    for (const line of content.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  }
  assert.equal(errors, 1);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o640);
});

test('a byte-trickling body still hits the absolute request deadline', { timeout: 10000 }, async t => {
  const { port, events } = await setup(t);
  const response = await new Promise((resolve, reject) => {
    let stream;
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('POST /admin/session HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n');
      stream = setInterval(() => { if (!socket.destroyed) socket.write('x'); }, 600);
      stream.unref();
    });
    let data = '';
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => { clearInterval(stream); resolve(data); });
    socket.on('error', error => { clearInterval(stream); reject(error); });
    t.after(() => { clearInterval(stream); socket.destroy(); });
  });
  assert.match(response, /^HTTP\/1\.1 408/);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail, 'Request body timeout');
});

function tempQuarantine(t, limits) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'honeypot-artifacts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, quarantine: createQuarantine(directory, limits) };
}

function sampleStream(bytes, declared = bytes.length) {
  const input = Readable.from([bytes]);
  if (declared !== null) input.headers = { 'content-length': String(declared) };
  return input;
}

test('raw binary uploads are content-addressed, deduplicated, private and never served back', async t => {
  const { directory, quarantine } = tempQuarantine(t);
  const { port, events } = await setup(t, { quarantine });
  const bytes = Buffer.from('\x7fELF inert test artifact; never executed');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': 'attachment; filename="../../escape.sh"' };
  const first = await request(port, { method: 'POST', path: '/api/upload', headers, body: bytes });
  assert.equal(first.status, 201);
  assert.equal(JSON.parse(first.body).sha256, sha);
  assert.deepEqual(fs.readdirSync(directory), [`${sha}.blob`]);
  const full = path.join(directory, `${sha}.blob`);
  assert.deepEqual(fs.readFileSync(full), bytes);
  assert.equal(fs.statSync(full).mode & 0o777, 0o400);
  const duplicate = await request(port, { method: 'PUT', path: '/upload', headers, body: bytes });
  assert.equal(duplicate.status, 200);
  assert.equal(quarantine.stats().samples, 1);
  assert.equal(quarantine.stats().bytes, bytes.length);
  assert.equal(events[0].event, 'http.upload');
  assert.equal(events[0].category, 'artifact');
  assert.equal(events[0].sample_sha256, sha);
  assert.equal(events[0].sample_size, bytes.length);
  assert.ok(!JSON.stringify(events).includes('escape.sh'));
  const retrieve = await request(port, { path: `/${sha}.blob` });
  assert.equal(retrieve.status, 404);
  assert.ok(!retrieve.body.includes('inert test artifact'));
});

test('non-binary, empty and oversized uploads are rejected without saved files', async t => {
  const { directory, quarantine } = tempQuarantine(t, { maxSampleBytes: 32, maxTotalBytes: 256 });
  const { port } = await setup(t, { quarantine });
  const multipart = await request(port, { method: 'POST', path: '/upload', headers: { 'Content-Type': 'multipart/form-data; boundary=bad' }, body: 'password=private' });
  assert.equal(multipart.status, 415);
  const empty = await request(port, { method: 'POST', path: '/upload', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 0 } });
  assert.equal(empty.status, 400);
  const declared = await request(port, { method: 'POST', path: '/upload', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 33 } });
  assert.equal(declared.status, 413);
  const streamed = await request(port, { method: 'POST', path: '/api/upload', headers: { 'Content-Type': 'application/octet-stream' }, body: 'a'.repeat(33) });
  assert.equal(streamed.status, 413);
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(quarantine.stats().active, 0);
});

test('upload capacity reservations cap concurrent disk usage and survive restart accounting', async t => {
  const { directory, quarantine } = tempQuarantine(t, { maxSampleBytes: 8, maxTotalBytes: 16, maxSamples: 2 });
  const one = new PassThrough(); one.headers = { 'content-length': '8' };
  const two = new PassThrough(); two.headers = { 'content-length': '8' };
  const first = quarantine.capture(one);
  const second = quarantine.capture(two);
  await assert.rejects(quarantine.capture(sampleStream(Buffer.from('z'))), error => error instanceof QuarantineError && error.statusCode === 507);
  assert.equal(quarantine.stats().reservedBytes, 16);
  one.end('12345678'); two.end('abcdefgh');
  await Promise.all([first, second]);
  assert.equal(quarantine.stats().bytes, 16);
  assert.equal(quarantine.stats().active, 0);
  assert.equal(quarantine.stats().reservedBytes, 0);
  const restarted = createQuarantine(directory, { maxSampleBytes: 8, maxTotalBytes: 16, maxSamples: 2 });
  assert.equal(restarted.stats().samples, 2);
  await assert.rejects(restarted.capture(sampleStream(Buffer.from('z'))), error => error.statusCode === 507);
});

test('at most four simultaneous uploads are accepted and failed streams clean their temporary files', async t => {
  const { directory, quarantine } = tempQuarantine(t, { maxSampleBytes: 8, maxTotalBytes: 64, maxSamples: 16 });
  const streams = Array.from({ length: 4 }, () => { const input = new PassThrough(); input.headers = { 'content-length': '8' }; return input; });
  const pending = streams.map(input => quarantine.capture(input));
  const results = Promise.allSettled(pending);
  await assert.rejects(quarantine.capture(sampleStream(Buffer.from('fifth'))), error => error.statusCode === 429);
  for (const input of streams) input.destroy(new Error('test disconnect'));
  await results;
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(quarantine.stats().active, 0);
  await assert.rejects(quarantine.capture(sampleStream(Buffer.from('short'), 8)), error => error.statusCode === 400);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('crash leftovers are removed, symlinks rejected, and client filenames cannot select destinations', async t => {
  const { directory } = tempQuarantine(t);
  fs.writeFileSync(path.join(directory, '.incoming-00000000-0000-0000-0000-000000000000'), 'leftover');
  const recovered = createQuarantine(directory);
  assert.deepEqual(fs.readdirSync(directory), []);
  const input = sampleStream(Buffer.from('small artifact'));
  input.headers['content-disposition'] = 'attachment; filename="../outside.sh"';
  const stored = await recovered.capture(input);
  assert.deepEqual(fs.readdirSync(directory), [`${stored.sha256}.blob`]);
  fs.symlinkSync('/etc/passwd', path.join(directory, `${'f'.repeat(64)}.blob`));
  assert.throws(() => createQuarantine(directory), /Unexpected quarantine entry/);
});

test('trusted ingress can supply a validated source IP but direct and malformed headers cannot', async t => {
  const direct = await setup(t);
  await request(direct.port, { headers: { 'X-Nightjar-Source': '203.0.113.10', 'X-Forwarded-For': '198.51.100.2' } });
  assert.equal(direct.events[0].source_ip, '127.0.0.1');
  const proxied = await setup(t, { trustedProxy: true });
  await request(proxied.port, { headers: { 'X-Nightjar-Source': '203.0.113.10', 'X-Forwarded-For': '198.51.100.2' } });
  assert.equal(proxied.events[0].source_ip, '203.0.113.10');
  await request(proxied.port, { headers: { 'X-Nightjar-Source': '203.0.113.10, 198.51.100.2' } });
  assert.equal(proxied.events[1].source_ip, '127.0.0.1');
});

test('an interrupted HTTP upload cleans quarantine files and releases its reservation', async t => {
  const { directory, quarantine } = tempQuarantine(t, { maxSampleBytes: 64, maxTotalBytes: 256 });
  const { port } = await setup(t, { quarantine });
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: 64\r\n\r\npartial');
      setTimeout(() => { socket.destroy(); resolve(); }, 30);
    });
    socket.on('error', reject);
  });
  for (let i = 0; i < 50 && quarantine.stats().active; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(quarantine.stats().active, 0);
  assert.equal(quarantine.stats().reservedBytes, 0);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('concurrent identical artifacts publish one immutable file', async t => {
  const { directory, quarantine } = tempQuarantine(t);
  const bytes = Buffer.from('same inert artifact');
  const results = await Promise.all([quarantine.capture(sampleStream(bytes)), quarantine.capture(sampleStream(bytes))]);
  assert.equal(results.filter(result => result.duplicate).length, 1);
  assert.equal(quarantine.stats().samples, 1);
  assert.equal(quarantine.stats().bytes, bytes.length);
  assert.equal(fs.readdirSync(directory).length, 1);
});

test('a slow binary upload receives 408 and leaves no partial sample', { timeout: 10000 }, async t => {
  const { directory, quarantine } = tempQuarantine(t, { maxSampleBytes: 128, maxTotalBytes: 512 });
  const { port, events } = await setup(t, { quarantine });
  const response = await new Promise((resolve, reject) => {
    let stream;
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('POST /api/upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: 128\r\n\r\n');
      stream = setInterval(() => { if (!socket.destroyed) socket.write('x'); }, 600);
      stream.unref();
    });
    let data = '';
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => { clearInterval(stream); resolve(data); });
    socket.on('error', error => { clearInterval(stream); reject(error); });
    t.after(() => { clearInterval(stream); socket.destroy(); });
  });
  assert.match(response, /^HTTP\/1\.1 408/);
  for (let i = 0; i < 50 && quarantine.stats().active; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(quarantine.stats().active, 0);
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(events[0].status, 408);
});
