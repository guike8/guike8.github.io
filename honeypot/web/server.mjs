import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { QuarantineError } from './quarantine.mjs';

export const MAX_BODY_BYTES = 8192;
export const MAX_URL_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 5000;
const ARTIFACT_TYPES = new Set(['application/octet-stream', 'application/x-executable', 'application/x-elf', 'application/x-dosexec', 'application/vnd.microsoft.portable-executable', 'application/x-msdownload', 'application/x-sharedlib']);

const STYLE = `:root{font-family:system-ui,-apple-system,sans-serif;color:#26313b;background:#f3f5f6}*{box-sizing:border-box}body{margin:0}header{background:#202b35;color:#eef3f7;padding:21px max(24px,calc((100vw - 960px)/2))}header strong{letter-spacing:.02em}header small{color:#acbbc8;margin-left:16px}main{max-width:960px;margin:42px auto;padding:0 24px}h1{font-size:28px;margin:0 0 8px}p{line-height:1.6;color:#61707c}.panel{background:white;border:1px solid #dbe1e5;border-radius:5px;padding:24px;margin:24px 0}a{color:#25658f;text-decoration:none}a:hover{text-decoration:underline}nav{display:flex;gap:24px;margin-top:20px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:13px 0;border-bottom:1px solid #edf0f2}th{color:#6d7b86;font-weight:500}.tag{font:12px ui-monospace,monospace;padding:5px 9px;border:1px solid #d9e3d8;background:#f1f6ee;color:#52674a;border-radius:3px}.muted{color:#83909a;font-size:13px}label{display:block;font-size:13px;margin-top:18px}input{display:block;margin-top:7px;width:100%;padding:11px;border:1px solid #cbd4db;border-radius:3px;font:inherit}button{padding:11px 20px;margin-top:22px;background:#294f6c;color:white;border:0;border-radius:3px;font:inherit;cursor:pointer}.login{max-width:400px}code{font-family:ui-monospace,monospace}footer{font-size:12px;color:#8b969f;margin-top:30px}@media(max-width:600px){header small{display:block;margin:8px 0 0}nav{gap:18px;flex-wrap:wrap}main{margin-top:28px}}`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Archive Console</title><style>${STYLE}</style></head><body><header><strong>ARCHIVE CONSOLE</strong><small>staging-02 / eu-west</small></header><main>${body}<footer>Archive Console 2.8.4 · Internal deployment</footer></main></body></html>`;
const HOME = page('Operations', `<h1>Operations archive</h1><p>Read-only deployment. Scheduled maintenance is in progress.</p><nav><a href="/archive/">Export index</a><a href="/api/status">Service status</a><a href="/admin/">Administration</a></nav><section class="panel"><table><thead><tr><th>Component</th><th>State</th><th>Last action</th></tr></thead><tbody><tr><td>Archive store</td><td><span class="tag">read only</span></td><td>Snapshot retained</td></tr><tr><td>Control API</td><td><span class="tag">degraded</span></td><td>Migration pending</td></tr><tr><td>Task runner</td><td><span class="tag">paused</span></td><td>Maintenance window</td></tr></tbody></table></section><p class="muted">Change request OPS-1842: rotate staging exports after the storage migration.</p><!-- Legacy export location: /backup/staging-02.sql. Deployment ref: /.git/HEAD. -->`);
const LOGIN = page('Administration', `<div class="login"><h1>Administration</h1><p>Sign in to manage this staging deployment.</p><form class="panel" method="post" action="/admin/session" autocomplete="off"><label>Username<input name="username" autocomplete="off" maxlength="64" required></label><label>Password<input name="password" type="password" autocomplete="off" maxlength="128" required></label><button type="submit">Sign in</button><p class="muted">Staging credentials only. Production access is managed separately.</p></form><a href="/">Return to archive</a></div>`);
const EXPIRED = page('Session unavailable', `<h1>Session unavailable</h1><p>The control plane is temporarily read only. Authentication could not be completed.</p><p><a href="/admin/">Try again</a> · <a href="/">Return to archive</a></p>`);
const ARCHIVE = page('Export index', `<h1>Export index</h1><p>Retained snapshots for the staging migration.</p><section class="panel"><table><tr><th>File</th><th>Format</th><th>State</th></tr><tr><td><a href="/backup/staging-02.sql">staging-02.sql</a></td><td>SQL</td><td>retained</td></tr><tr><td><a href="/backup/manifest.json">manifest.json</a></td><td>JSON</td><td>verified</td></tr><tr><td><a href="/api/version">deployment.json</a></td><td>JSON</td><td>current</td></tr></table></section><a href="/">Return to archive</a>`);
const UPLOAD = page('Artifact intake', `<h1>Artifact intake</h1><p>The staging intake service accepts raw binary build artifacts.</p><section class="panel"><p>Submit a raw POST or PUT to <code>/api/upload</code> with <code>Content-Type: application/octet-stream</code>. Maximum artifact size: 2 MiB.</p><p class="muted">Multipart submissions are unavailable during the storage migration. Accepted artifacts remain quarantined pending review.</p></section><a href="/">Return to archive</a>`);
const NOT_FOUND = page('Not found', '<h1>Not found</h1><p>The requested resource is unavailable on this deployment.</p><a href="/">Return to archive</a>');
// All configuration values and export data below are invented and grant no real access.
const ENV = '# Archive Console staging deployment\nAPP_NAME=archive-console\nAPP_ENV=staging\nAPP_VERSION=2.8.4\nAPP_HOST=staging-02\nDB_HOST=127.0.0.1\nDB_DATABASE=archive_staging\nDB_USERNAME=archive_demo\nDB_PASSWORD=stg_arch_7qB4mP2x\nBACKUP_PATH=/backup/staging-02.sql\n';
const SQL = '-- Archive Console staging export\nCREATE TABLE archive_jobs (id INTEGER, name TEXT, status TEXT);\nINSERT INTO archive_jobs VALUES (1, \'nightly-staging\', \'paused\');\nINSERT INTO archive_jobs VALUES (2, \'migration-check\', \'complete\');\n';
const ROBOTS = 'User-agent: *\nDisallow: /admin/\nDisallow: /backup/\nDisallow: /archive/\nDisallow: /api/internal/\nDisallow: /upload\n';
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const clean = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, max);

function telemetryText(value, max) {
  let text = clean(value, 8192);
  try { text = decodeURIComponent(text); } catch { /* Preserve malformed targets for classification. */ }
  text = clean(text, 8192)
    .replace(/\b(bearer|basic)(?:\s+|:)[^\s;,]+/gi, '$1 [redacted]')
    .replace(/\b(password|passwd|pwd|token|api[_-]?key|secret|access[_-]?token|session|authorization)(\s*[:=]\s*)[^\s;&,/?]+/gi, '$1$2[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@');
  return text.slice(0, max);
}

function classify(path, rawUrl, method) {
  const lower = `${path} ${rawUrl}`.toLowerCase();
  if (/\.\.\/|%2e|%252e|\/cgi-bin\/|\/shell|\/vendor\/phpunit|\/actuator|\/boaform|\/HNAP1|union(?:\+|%20| )select|(?:%3c|<)script|(?:%24|\$)(?:%7b|\{)/i.test(lower)) {
    return { category: 'exploitation', detail: 'Exploit-style URL probe' };
  }
  if (/^\/(?:admin(?:\/|$)|login(?:\/|$)|wp-admin(?:\/|$)|wp-login\.php(?:\/|$)|api\/(?:login|auth|session)(?:\/|$))/.test(path)) {
    return { category: 'authentication', detail: /^(POST|PUT|PATCH)$/.test(method) ? 'Authentication submission discarded' : 'Authentication endpoint requested' };
  }
  if (/^\/(?:\.env|\.git(?:\/|$)|backup(?:\/|$)|archive(?:\/|$))/.test(path) || /\.(?:sql|bak|old|zip|tar|gz)$/.test(path)) {
    return { category: 'reconnaissance', detail: 'Configuration or archive probe' };
  }
  return { category: 'discovery', detail: path === '/' ? 'Landing page requested' : 'Endpoint discovery' };
}

function resolveRoute(path, method) {
  const read = method === 'GET' || method === 'HEAD';
  const admin = /^\/(?:admin(?:\/.*)?|login\/?|wp-admin(?:\/.*)?|wp-login\.php)$/.test(path);
  if (!read) {
    if (admin || /^\/api\/(?:auth|login|session)(?:\/|$)/.test(path)) {
      if (method === 'POST') return { status: 303, type: 'text/html; charset=utf-8', body: EXPIRED, headers: { Location: '/admin/unavailable' } };
    }
    return { status: 405, type: 'application/json; charset=utf-8', body: json({ error: 'method_not_allowed', maintenance: true }), headers: { Allow: 'GET, HEAD' } };
  }
  if (path === '/') return { status: 200, body: HOME };
  if (path === '/upload' || path === '/api/upload') return { status: 200, body: UPLOAD };
  if (path === '/robots.txt') return { status: 200, type: 'text/plain; charset=utf-8', body: ROBOTS };
  if (path === '/favicon.ico') return { status: 204, body: '' };
  if (path === '/.env' || path === '/.env.backup') return { status: 200, type: 'text/plain; charset=utf-8', body: ENV };
  if (path === '/.git/HEAD') return { status: 200, type: 'text/plain; charset=utf-8', body: 'ref: refs/heads/staging\n' };
  if (path === '/.git/config') return { status: 200, type: 'text/plain; charset=utf-8', body: '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = https://git.example.invalid/infrastructure/archive-console.git\n[branch "staging"]\n\tremote = origin\n\tmerge = refs/heads/staging\n' };
  if (path === '/.git/refs/heads/staging') return { status: 200, type: 'text/plain; charset=utf-8', body: 'd8a4e7d11a448d4effcbb4d8e4d98d7f7bb13c6c\n' };
  if (path === '/archive/' || path === '/archive' || path === '/backup/' || path === '/backup') return { status: 200, body: ARCHIVE };
  if (path === '/backup/staging-02.sql' || path === '/backup.sql') return { status: 200, type: 'text/plain; charset=utf-8', body: SQL };
  if (path === '/backup/manifest.json') return { status: 200, type: 'application/json; charset=utf-8', body: json({ deployment: 'staging-02', schema_version: 12, exports: [{ name: 'staging-02.sql', state: 'retained' }], retention: 'migration' }) };
  if (path === '/admin/unavailable') return { status: 503, body: EXPIRED, headers: { 'Retry-After': '3600' } };
  if (admin) return { status: 200, body: LOGIN };
  if (path === '/api/status' || path === '/health' || path === '/healthz') return { status: 200, type: 'application/json; charset=utf-8', body: json({ status: 'degraded', deployment: 'staging-02', mode: 'read-only', components: { archive: 'available', control: 'maintenance', tasks: 'paused' } }) };
  if (path === '/api/version') return { status: 200, type: 'application/json; charset=utf-8', body: json({ service: 'archive-console', version: '2.8.4', branch: 'staging', schema_version: 12 }) };
  if (path.startsWith('/api/internal/') || path === '/api/config') return { status: 403, type: 'application/json; charset=utf-8', body: json({ error: 'access_denied', message: 'Control plane access is restricted during maintenance.' }) };
  if (path.startsWith('/api/')) return { status: 404, type: 'application/json; charset=utf-8', body: json({ error: 'not_found', deployment: 'staging-02' }) };
  return { status: 404, body: NOT_FOUND };
}

/** A low-interaction decoy. Payloads are never executed, parsed or fetched from URLs. */
export function createDecoyServer({ emit = () => {}, clock = () => new Date(), quarantine, trustedProxy = false } = {}) {
  const sockets = new Set();
  function handle(req, res, expectContinue = false) {
    let recorded = false;
    let responded = false;
    let received = 0;
    let deadline;
    const uploadAbort = new AbortController();
    let sample;
    const method = clean(req.method, 16);
    const rawUrl = String(req.url ?? '/');
    const rawPath = rawUrl.split('?', 1)[0];
    let path = clean(rawPath, 256);
    let invalidPath = !rawPath.startsWith('/') || rawPath.includes('#');
    try {
      const decoded = decodeURIComponent(rawPath);
      if (/[\x00-\x1f\x7f]/.test(decoded)) invalidPath = true;
    } catch { invalidPath = true; }
    const isUpload = (path === '/upload' || path === '/api/upload') && (method === 'POST' || method === 'PUT');
    const signal = isUpload ? { category: 'artifact', detail: 'Artifact intake request' } : classify(path, rawUrl.slice(0, MAX_URL_BYTES), method);
    const proxyIP = req.headers['x-nightjar-source'];
    const sourceIP = trustedProxy && typeof proxyIP === 'string' && isIP(proxyIP) ? proxyIP : req.socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown';
    function record(status, detail = signal.detail) {
      if (recorded) return;
      recorded = true;
      const event = {
        id: randomUUID(), timestamp: new Date(clock()).toISOString(), protocol: 'http', event: isUpload ? 'http.upload' : 'http.request',
        source_ip: clean(sourceIP, 64),
        method, path: telemetryText(path, 256), category: signal.category, status,
        user_agent: telemetryText(req.headers['user-agent'], 256), detail: clean(detail, 256),
        ...(sample ? { sample_sha256: sample.sha256, sample_size: sample.size } : {}),
      };
      try { const result = emit(event); if (result?.catch) result.catch(() => {}); } catch { /* Logging failure cannot expose internals to a visitor. */ }
    }
    function respond(route) {
      if (responded || res.destroyed) return;
      responded = true;
      clearTimeout(deadline);
      record(route.status, route.detail);
      const body = Buffer.from(route.body ?? '');
      res.writeHead(route.status, {
        Server: 'nginx',
        'Content-Type': route.type ?? 'text/html; charset=utf-8',
        'Content-Length': body.byteLength,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'Referrer-Policy': 'no-referrer',
        Connection: 'close',
        ...(route.headers ?? {}),
      });
      res.end(method === 'HEAD' || route.status === 204 ? undefined : body);
    }
    function timeout() {
      respond({ status: 408, type: 'text/plain; charset=utf-8', body: 'Request timeout\n', detail: 'Request body timeout' });
      req.socket.end();
      if (isUpload) uploadAbort.abort();
    }
    deadline = setTimeout(timeout, REQUEST_TIMEOUT_MS);
    deadline.unref();
    req.on('close', () => clearTimeout(deadline));
    req.setTimeout(REQUEST_TIMEOUT_MS, timeout);
    req.on('aborted', () => { uploadAbort.abort(); record(499, 'Client disconnected before request completed'); });
    req.on('error', () => record(400, 'Request stream error'));
    const contentLength = Number(req.headers['content-length'] || 0);
    if (rawUrl.length > MAX_URL_BYTES) {
      path = '[oversized-url]';
      respond({ status: 414, body: NOT_FOUND, detail: 'URL exceeded size limit' });
      req.resume();
      return;
    }
    if (invalidPath) {
      respond({ status: 400, body: NOT_FOUND, detail: 'Malformed request target' });
      req.resume();
      return;
    }
    if (isUpload) {
      const uploadReply = (status, code, detail) => respond({ status, type: 'application/json; charset=utf-8', body: json({ error: code }), detail });
      if (!quarantine) { uploadReply(503, 'intake_unavailable', 'Artifact intake is disabled'); req.resume(); return; }
      const mediaType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (!ARTIFACT_TYPES.has(mediaType)) { uploadReply(415, 'raw_binary_required', 'Non-binary artifact submission rejected'); req.resume(); return; }
      if (contentLength > quarantine.stats().maxSampleBytes) { uploadReply(413, 'artifact_too_large', 'Artifact exceeded size limit'); req.resume(); return; }
      if (expectContinue) res.writeContinue();
      quarantine.capture(req, { signal: uploadAbort.signal }).then(result => {
        sample = result;
        respond({ status: result.duplicate ? 200 : 201, type: 'application/json; charset=utf-8', body: json({ status: 'quarantined', sha256: result.sha256, size: result.size }), detail: `Artifact ${result.duplicate ? 'deduplicated' : 'uploaded'} ${result.sha256}` });
      }).catch(error => {
        const known = error instanceof QuarantineError;
        uploadReply(known ? error.statusCode : 503, known ? error.code : 'intake_unavailable', 'Artifact intake rejected or interrupted');
        req.resume();
      });
      return;
    }
    if (contentLength > MAX_BODY_BYTES) {
      respond({ status: 413, body: NOT_FOUND, detail: 'Request body exceeded size limit' });
      req.resume();
      return;
    }
    if (expectContinue) res.writeContinue();
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) respond({ status: 413, body: NOT_FOUND, detail: 'Request body exceeded size limit' });
    });
    req.on('end', () => respond(resolveRoute(path, method)));
  }
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: REQUEST_TIMEOUT_MS, keepAliveTimeout: 1000 }, handle);
  server.maxConnections = 96;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(7500, socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('checkContinue', (req, res) => handle(req, res, true));
  server.on('clientError', (error, socket) => {
    // Parser errors have no trusted HTTP request object and are deliberately excluded from telemetry.
    if (socket.writable) socket.end(`HTTP/1.1 ${error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  });
  server.closeClients = () => { for (const socket of sockets) socket.destroy(); };
  return server;
}
