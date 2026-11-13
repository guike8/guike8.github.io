import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export const MAX_LINE_BYTES = 64 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']);
const HANDLER = /^(authentication|reconnaissance|exploitation|discovery|artifact):([1-5][0-9]{2})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 8192) : '';

function redact(value, maximum) {
  let text = clean(value);
  for (let i = 0; i < 2; i++) {
    try { const decoded = decodeURIComponent(text); if (decoded === text) break; text = decoded; }
    catch { break; }
  }
  return clean(text)
    .replace(/\b(Bearer|Basic)(?:\s+|:)[^\s;,]+/gi, '$1 [redacted]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|session|access[_-]?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;&,/?]+)/gi, '$1=[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .slice(0, maximum);
}

function requestPath(value) {
  let path = clean(value).split(/[?#]/, 1)[0];
  for (let i = 0; i < 2; i++) {
    try { const decoded = decodeURIComponent(path); if (decoded === path) break; path = decoded; }
    catch { break; }
  }
  // Encoded query separators must not reintroduce secret query values.
  path = path.split(/[?#]/, 1)[0];
  if (!path.startsWith('/')) return '/[invalid-target]';
  return redact(path, 256).split(/[?#]/, 1)[0];
}

function categoryFor(path) {
  if (/\.\.\/|%2e|\/cgi-bin\/|\/vendor\/phpunit|\/actuator|\/shell(?:\/|\.|$)|<script/i.test(path)) return 'exploitation';
  if (/^\/(?:admin(?:\/|$)|login(?:\/|$)|wp-admin(?:\/|$)|wp-login\.php|api\/(?:login|auth|session)(?:\/|$))/.test(path)) return 'authentication';
  if (/^\/(?:\.env|\.git(?:\/|$)|backup(?:\/|$)|archive(?:\/|$))/.test(path)) return 'reconnaissance';
  return 'discovery';
}

function validIP(value) {
  return typeof value === 'string' && value.length <= 64 && isIP(value) ? value.replace(/^::ffff:/, '') : null;
}

function ingressIP(headers) {
  if (!object(headers)) return null;
  const candidates = Object.entries(headers).filter(([name]) => name.toLowerCase() === 'x-nightjar-source');
  if (candidates.length !== 1) return null;
  const values = candidates[0][1];
  return Array.isArray(values) && values.length === 1 ? validIP(values[0]) : null;
}

// Verified against Beelzebub v3.10.0 (a02d0354e19a01e97eeccaf1874419dcb05b94ca):
// internal/builder/director.go standardOutStrategy and internal/tracer/tracer.go.
// Everything not explicitly selected here, including Body/Cookies/Headers,
// credentials, rendered messages, outputs and nested Metadata, is discarded.
export function normalizeBeelzebubEvent(record, { trustedProxy = false, now = Date.now() } = {}) {
  if (!object(record) || record.msg !== 'New Event' || !object(record.event)) return null;
  const raw = record.event;
  if (raw.Protocol !== 'HTTP' || typeof raw.RequestURI !== 'string' || typeof raw.HTTPMethod !== 'string') return null;
  const path = raw.RequestURI.length > 4096 ? '/[oversized-target]' : requestPath(raw.RequestURI);
  const configured = typeof raw.Handler === 'string' ? HANDLER.exec(raw.Handler) : null;
  const classified = categoryFor(path);
  const time = typeof raw.DateTime === 'string' && raw.DateTime.length <= 40 ? Date.parse(raw.DateTime) : NaN;
  // SourceIp is computed by native socket/trustedProxies handling, not an
  // arbitrary raw header. The extra header fallback requires isolated ingress.
  const source = validIP(raw.SourceIp) ?? (trustedProxy ? ingressIP(raw.HeadersMap) : null) ?? 'unknown';
  const method = raw.HTTPMethod.toUpperCase();
  return {
    id: typeof raw.ID === 'string' && UUID.test(raw.ID) ? raw.ID.toLowerCase() : randomUUID(),
    timestamp: new Date(Number.isFinite(time) && time <= now + 300_000 ? time : now).toISOString(),
    protocol: 'http', event: 'http.request', source_ip: source,
    method: METHODS.has(method) ? method : 'OTHER', path,
    category: classified === 'exploitation' ? classified : configured && configured[1] !== 'discovery' ? configured[1] : classified,
    // The release emits lifecycle Status='Stateless', not an HTTP response code.
    // Configured static command names encode the intended code; an empty Handler
    // is the release's method-mismatch branch, whose fixed response is 405.
    status: configured ? Number(configured[2]) : raw.Handler === '' ? 405 : null,
    user_agent: redact(raw.UserAgent, 256), detail: 'Beelzebub HTTP request',
  };
}

/** Bound retained input by bytes, discard whole oversized lines, resume at LF. */
export function createBoundedLineDecoder({ onLine = () => {}, onDiscard = () => {}, maxLineBytes = MAX_LINE_BYTES } = {}) {
  if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > MAX_LINE_BYTES) throw new Error('Invalid line limit');
  let chunks = [];
  let buffered = 0;
  let discarding = false;
  return {
    write(input) {
      const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline < 0 ? bytes.length : newline;
        const length = end - start;
        if (!discarding && buffered + length > maxLineBytes) {
          chunks = []; buffered = 0; discarding = true;
          onDiscard('oversized');
        }
        if (!discarding && length) {
          // Copy only bounded fragments, never retain a view into a huge chunk.
          chunks.push(Buffer.from(bytes.subarray(start, end))); buffered += length;
        }
        if (newline >= 0) {
          if (!discarding && buffered) onLine(Buffer.concat(chunks, buffered).toString('utf8'));
          chunks = []; buffered = 0; discarding = false;
          start = newline + 1;
        } else break;
      }
    },
    end() {
      if (buffered && !discarding) onDiscard('incomplete');
      chunks = []; buffered = 0; discarding = false;
    },
    get bufferedBytes() { return buffered; },
  };
}

/** Parse complete stdout lines only; never strip diagnostic prefixes or recurse into msg. */
export function createBeelzebubAdapter({ emit = () => {}, diagnostic = () => {}, trustedProxy = false, clock = () => Date.now() } = {}) {
  return createBoundedLineDecoder({
    onLine(line) {
      let record;
      try { record = JSON.parse(line); } catch { diagnostic('suppressed'); return; }
      const normalized = normalizeBeelzebubEvent(record, { trustedProxy, now: clock() });
      if (!normalized) { diagnostic('suppressed'); return; }
      try { const pending = emit(normalized); pending?.catch?.(() => diagnostic('storage')); }
      catch { diagnostic('storage'); }
    },
    onDiscard() { diagnostic('suppressed'); },
  });
}
