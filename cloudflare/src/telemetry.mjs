// Metadata only. No request body, credentials, cookies, or arbitrary headers are read.
const DAY_MS = 86_400_000;
const CLEANUP_MS = 15 * 60_000;
const DAILY_LIMIT = 5_000;
const RETAINED_LIMIT = 20_000;
const RETENTION_DAYS = 7;
const CATEGORIES = new Set(['authentication', 'reconnaissance', 'exploitation', 'discovery', 'artifact', 'other']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);
const COLUMNS = 'id, timestamp_ms, method, path, category, status, source_hash, country, user_agent';
let cachedSecret;
let cachedKey;

const INSERT = `INSERT INTO events (${COLUMNS})
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE COALESCE((SELECT retained_count FROM telemetry_stats WHERE id = 1), 0) < 20000
    AND COALESCE((SELECT admitted_count FROM telemetry_days WHERE day = ?), 0) < 5000
  RETURNING id`;

function timestamp(now) {
  return typeof now === 'number' && Number.isFinite(now) && now >= 0 && now <= 8_640_000_000_000_000
    ? Math.floor(now) : null;
}

function ipv4(value) {
  const pieces = value.split('.');
  return pieces.length === 4 && pieces.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
    ? pieces.map(Number).join('.') : null;
}

function ipAddress(value) {
  if (typeof value !== 'string' || value.length > 45 || value.trim() !== value) return null;
  if (!value.includes(':')) return ipv4(value);
  let source = value.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(source) || source.includes(':::')) return null;
  if (source.includes('.')) {
    const colon = source.lastIndexOf(':');
    const tail = ipv4(source.slice(colon + 1));
    if (!tail) return null;
    const octets = tail.split('.').map(Number);
    source = `${source.slice(0, colon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (![...left, ...right].every(part => /^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map(part => parseInt(part, 16).toString(16));
  return groups.join(':');
}

async function sourceHash(env, request, day) {
  const address = ipAddress(request.headers.get('CF-Connecting-IP'));
  if (!address) return null;
  const secret = env.IP_HASH_KEY;
  if (cachedSecret !== secret) {
    cachedSecret = secret;
    cachedKey = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  const signature = await crypto.subtle.sign('HMAC', await cachedKey, new TextEncoder().encode(`v1\n${day}\n${address}`));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

function safePath(value) {
  if (typeof value !== 'string') return '/';
  let path = value.slice(0, 2048);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try { path = new URL(path).pathname; } catch { return '/[redacted]'; }
  }
  // Decode twice so encoded query delimiters and credential names are also removed.
  for (let i = 0; i < 2; i++) {
    try { path = decodeURIComponent(path); } catch { break; }
  }
  path = path.split(/[?#]/, 1)[0].replace(/[\u0000-\u001f\u007f]/g, '');
  if (!path.startsWith('/')) path = `/${path}`;
  let redactNext = false;
  const parts = path.split('/').map(part => {
    if (!part) return part;
    if (redactNext) { redactNext = false; return '[redacted]'; }
    if (/^(?:user|username|password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|authorization|credential|session|sessionid)$/i.test(part)) {
      redactNext = true;
      return part.toLowerCase();
    }
    if (/[@%]/.test(part) || /(?:user|username|password|passwd|pwd|secret|token|api[-_]?key|authorization|credential)\s*[:=]/i.test(part)
      || /^eyJ[A-Za-z0-9_-]+\./.test(part) || /^(?:bearer|basic)\s/i.test(part)
      || /^[0-9a-f]{24,}$/i.test(part) || /^[A-Za-z0-9_+=-]{32,}$/.test(part)
      || /^(?:gh[pousr]_|github_pat_|sk[-_]|AKIA|ASIA)/.test(part)) return '[redacted]';
    return part.length > 64 ? '[redacted]' : part;
  });
  return parts.join('/').slice(0, 160);
}

function userAgent(value) {
  // Keep only recognized product/version tokens; attacker-controlled comments may contain secrets.
  const raw = typeof value === 'string' ? value.slice(0, 4096) : '';
  for (const family of ['Edg', 'Chrome', 'Firefox', 'Version', 'curl', 'Wget', 'python-requests', 'Go-http-client', 'Googlebot', 'bingbot', 'Mozilla']) {
    const match = raw.match(new RegExp(`(?:^|[\\s;(])(${family}\\/[0-9]{1,4}(?:\\.[0-9]{1,4}){0,3})(?=$|[\\s;)])`, 'i'));
    if (match) return match[1].slice(0, 160);
  }
  return 'unknown';
}

function emptyOverview() {
  return { available: false, total_events: 0, daily_events: 0, daily_limit: DAILY_LIMIT, retained_limit: RETAINED_LIMIT,
    retention_days: RETENTION_DAYS, first_event_ms: null, last_event_ms: null };
}

/** Admit at most 5,000 events per UTC day and retain at most 20,000 atomically. */
export async function recordEvent(env, request, { category, status, path } = {}, now = Date.now()) {
  if (!env?.DB?.prepare || typeof env.IP_HASH_KEY !== 'string' || env.IP_HASH_KEY.length < 32) return false;
  const time = timestamp(now);
  if (time === null) return false;
  try {
    const day = Math.floor(time / DAY_MS);
    const countryHeader = request.headers.get('CF-IPCountry');
    const country = /^[A-Za-z]{2}$/.test(countryHeader ?? '') ? countryHeader.toUpperCase() : null;
    const result = await env.DB.prepare(INSERT).bind(
      crypto.randomUUID(), time, METHODS.has(request.method) ? request.method : 'OTHER',
      safePath(path ?? new URL(request.url).pathname), CATEGORIES.has(category) ? category : 'other',
      Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      await sourceHash(env, request, day), country, userAgent(request.headers.get('User-Agent')), day
    ).first();
    return Boolean(result?.id);
  } catch { return false; }
}

function decodeCursor(before) {
  if (before === undefined || before === null || before === '') return null;
  if (typeof before !== 'string' || before.length > 100) return false;
  const match = /^(\d{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(before);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return false;
  return [Number(match[1]), match[2]];
}

export async function readEvents(env, { limit = 50, before } = {}) {
  const empty = { events: [], next_before: null };
  if (!env?.DB?.prepare) return empty;
  const count = Number.isInteger(Number(limit)) ? Math.max(1, Math.min(100, Number(limit))) : 50;
  const cursor = decodeCursor(before);
  if (cursor === false) return empty;
  try {
    const query = cursor
      ? `SELECT ${COLUMNS} FROM events WHERE (timestamp_ms, id) < (?, ?) ORDER BY timestamp_ms DESC, id DESC LIMIT ?`
      : `SELECT ${COLUMNS} FROM events ORDER BY timestamp_ms DESC, id DESC LIMIT ?`;
    const statement = env.DB.prepare(query);
    const result = await (cursor ? statement.bind(...cursor, count + 1) : statement.bind(count + 1)).all();
    const rows = result.results ?? [];
    const events = rows.slice(0, count);
    const last = events.at(-1);
    return { events, next_before: rows.length > count && last ? `${last.timestamp_ms}:${last.id}` : null };
  } catch { return empty; }
}

export async function overview(env) {
  const empty = emptyOverview();
  if (!env?.DB?.prepare) return empty;
  try {
    const result = await env.DB.prepare(`SELECT
      COALESCE((SELECT retained_count FROM telemetry_stats WHERE id = 1), 0) AS total_events,
      COALESCE((SELECT admitted_count FROM telemetry_days WHERE day = ?), 0) AS daily_events,
      (SELECT timestamp_ms FROM events ORDER BY timestamp_ms, id LIMIT 1) AS first_event_ms,
      (SELECT timestamp_ms FROM events ORDER BY timestamp_ms DESC, id DESC LIMIT 1) AS last_event_ms`
    ).bind(Math.floor(Date.now() / DAY_MS)).first();
    return { ...empty, ...result, available: true };
  } catch { return empty; }
}

/** Claim one cleanup per 15 minutes. Failed cleanup releases no additional work until the next window. */
export async function pruneEvents(env, now = Date.now()) {
  const time = timestamp(now);
  if (!env?.DB?.prepare || !env.DB.batch || time === null) return 0;
  try {
    const claim = await env.DB.prepare(`UPDATE telemetry_stats SET cleanup_after_ms = ?
      WHERE id = 1 AND cleanup_after_ms <= ? RETURNING id`).bind(time + CLEANUP_MS, time).first();
    if (!claim) return 0;
    const result = await env.DB.batch([
      env.DB.prepare(`DELETE FROM events WHERE id IN (
        SELECT id FROM events WHERE timestamp_ms < ? ORDER BY timestamp_ms, id LIMIT 100
      )`).bind(time - RETENTION_DAYS * DAY_MS),
      env.DB.prepare(`DELETE FROM telemetry_days WHERE day IN (
        SELECT day FROM telemetry_days WHERE day < ? ORDER BY day LIMIT 100
      )`).bind(Math.floor(time / DAY_MS) - RETENTION_DAYS)
    ]);
    return Number(result[0]?.meta?.changes ?? 0);
  } catch { return 0; }
}
