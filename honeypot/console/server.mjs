import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sampleInventory } from './samples.mjs';

const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function createConsoleServer({store, token, publicDirectory = new URL('./public/', import.meta.url), quarantineDirectory, health = () => ({status:'ok'})}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Console token must contain at least 32 characters');
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const assets = new Map([...STATIC].map(([route, [file, type]]) => [route, {data:readFileSync(new URL(file, publicDirectory)), type}]));
  const server = http.createServer({maxHeaderSize:8192}, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const respond = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {'Content-Type':type, 'Connection':'close'});
      res.end(req.method === 'HEAD' ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (req.url.length > 4096) return respond(414, {error:'request too long'});
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return respond(400, {error:'invalid request'}); }
    if (!['GET', 'HEAD'].includes(req.method)) { req.resume(); return respond(405, {error:'read-only API'}); }
    if (url.pathname.startsWith('/api/')) {
      const supplied = createHash('sha256').update(req.headers.authorization ?? '').digest();
      if (!timingSafeEqual(supplied, expected)) return respond(401, {error:'console token required'});
      // Same-origin fetches and CLI use only. No CORS and no cookie sessions.
      if (req.headers['sec-fetch-site'] === 'cross-site') return respond(403, {error:'cross-site request rejected'});
      try {
        if (url.pathname === '/api/health') return respond(200, health());
        if (url.pathname === '/api/samples') return respond(200, sampleInventory(quarantineDirectory));
        if (url.pathname === '/api/overview') return respond(200, {...store.overview(), ingest:health()});
        if (url.pathname === '/api/events') {
          const protocol = url.searchParams.get('protocol') ?? 'all';
          if (!['all', 'http', 'ssh'].includes(protocol)) return respond(400, {error:'invalid protocol'});
          return respond(200, store.query({protocol, category:url.searchParams.get('category') ?? '', q:url.searchParams.get('q') ?? '', limit:Math.min(500, Number(url.searchParams.get('limit')) || 100)}));
        }
        if (url.pathname === '/api/export') {
          res.setHeader('Content-Disposition', 'attachment; filename="nightjar-events.ndjson"');
          return respond(200, store.query({limit:5000}).events.map(event => JSON.stringify(event)).join('\n')+'\n', 'application/x-ndjson; charset=utf-8');
        }
        return respond(404, {error:'not found'});
      } catch { return respond(503, {error:'event store temporarily unavailable'}); }
    }
    const asset = assets.get(url.pathname);
    if (!asset) return respond(404, {error:'not found'});
    respond(200, asset.data, asset.type);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.timeout = 15_000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 32;
  server.on('timeout', socket => socket.destroy());
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return server;
}
