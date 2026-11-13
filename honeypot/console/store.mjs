import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export function clean(value, max = 256) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

export function redact(value, max = 1024) {
  return clean(value, max)
    .replace(/\b(Bearer|Basic)\s+[^\s;]+/gi, '$1 [redacted]')
    .replace(/\b(password|passwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s;&]+)/gi, '$1=[redacted]');
}

export function normalizeEvent(raw, protocol, id, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const event = clean(raw.event ?? raw.eventid, 80);
  if (protocol === 'ssh' && !/^cowrie\.(session\.(connect|closed)|login\.(success|failed)|command\.(input|failed)|client\.(version|kex)|direct-tcpip\.(request|data)|session\.file_(download|upload)(\.failed)?|sensor\.dropped)$/.test(event)) return null;
  const time = Date.parse(raw.timestamp);
  const timestamp = new Date(Number.isFinite(time) && time <= now + 300_000 ? time : now).toISOString();
  let source = clean(raw.source_ip ?? raw.src_ip, 64).replace(/^::ffff:/, '');
  if (!isIP(source)) source = 'unknown';
  let path = clean(raw.path, 256).split(/[?#]/, 1)[0];
  if (path && !path.startsWith('/')) path = '/[invalid]';
  // Store targets, never query values, submitted credentials, cookies or headers.
  path = redact(path, 256);
  let category = clean(raw.category, 32);
  let detail = redact(raw.detail);
  if (protocol === 'ssh') {
    category = /login/.test(event) ? 'authentication' : /command/.test(event) ? 'execution' : /tcpip|download|upload/.test(event) ? 'transfer' : 'connection';
    detail = /command/.test(event) ? redact(raw.input) : /login/.test(event) ? `username: ${clean(raw.username, 80)}` : /client.version/.test(event) ? clean(raw.version, 160) : /client.kex/.test(event) ? `HASSH: ${clean(raw.hassh, 32)}` : /session.closed/.test(event) ? `duration: ${Number.isFinite(Number(raw.duration)) ? Math.min(Number(raw.duration), 86400) : 0}s` : /tcpip|download|upload/.test(event) ? `transfer blocked ${redact(raw.url, 256)}` : /sensor.dropped/.test(event) ? `${Math.max(0, Math.min(1000000, Number(raw.count) || 0))} events dropped by rate limit` : 'SSH session opened';
  }
  if (!['authentication', 'execution', 'transfer', 'connection', 'reconnaissance', 'exploitation', 'discovery', 'artifact'].includes(category)) category = 'discovery';
  return {
    id: clean(id, 80), timestamp, protocol, event, source,
    method: protocol === 'http' ? clean(raw.method, 16) : '', path,
    category, status: Number.isInteger(raw.status) ? Math.max(0, Math.min(599, raw.status)) : null,
    user_agent: protocol === 'http' ? redact(raw.user_agent, 256) : '',
    detail, session: clean(raw.session, 80),
  };
}

export class EventStore {
  constructor(path, { retentionDays = 7, maxEvents = 50_000, now = () => Date.now() } = {}) {
    this.retentionDays = retentionDays;
    this.maxEvents = maxEvents;
    this.now = now;
    this.db = new DatabaseSync(path, { timeout: 2000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA auto_vacuum=INCREMENTAL;
      PRAGMA journal_size_limit=16777216; PRAGMA max_page_count=32768;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, protocol TEXT NOT NULL, event TEXT NOT NULL,
        source TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, category TEXT NOT NULL,
        status INTEGER, user_agent TEXT NOT NULL, detail TEXT NOT NULL, session TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_time ON events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS events_session ON events(session);
      CREATE TABLE IF NOT EXISTS cursors (identity TEXT PRIMARY KEY, offset INTEGER NOT NULL, seen_at INTEGER NOT NULL);`);
    this.insert = this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.prune();
  }
  cursor(identity) { return Number(this.db.prepare('SELECT offset FROM cursors WHERE identity=?').get(identity)?.offset ?? 0); }
  ingest(identity, offset, records, protocol) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { raw, position } of records) {
        const id = createHash('sha256').update(`${identity}:${position}`).digest('hex').slice(0, 32);
        const event = normalizeEvent(raw, protocol, id, this.now());
        if (event) this.insert.run(...Object.values(event));
      }
      this.db.prepare('INSERT INTO cursors VALUES (?,?,?) ON CONFLICT(identity) DO UPDATE SET offset=excluded.offset, seen_at=excluded.seen_at').run(identity, offset, this.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  add(raw, protocol = 'http', id = randomUUID()) {
    const event = normalizeEvent(raw, protocol, id, this.now());
    if (event) this.insert.run(...Object.values(event));
    return event;
  }
  prune() {
    const cutoff = new Date(this.now() - this.retentionDays * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff);
    this.db.prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY timestamp DESC LIMIT -1 OFFSET ?)').run(this.maxEvents);
    this.db.prepare('DELETE FROM cursors WHERE seen_at < ?').run(this.now() - this.retentionDays * 86_400_000);
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(512);');
  }
  query({ protocol = 'all', category = '', q = '', limit = 100 } = {}) {
    const clauses = [], parameters = [];
    if (protocol !== 'all') { clauses.push('protocol=?'); parameters.push(protocol); }
    if (category) { clauses.push('category=?'); parameters.push(category); }
    if (q) {
      clauses.push("(source LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR session LIKE ? ESCAPE '\\')");
      const like = `%${clean(q, 128).replace(/[\\%_]/g, '\\$&')}%`;
      parameters.push(like, like, like, like);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM events${where}`).get(...parameters).n;
    const events = this.db.prepare(`SELECT * FROM events${where} ORDER BY timestamp DESC, id DESC LIMIT ?`).all(...parameters, Math.max(1, Math.min(5000, Number(limit) || 100)));
    return { total: Number(total), events };
  }
  overview() {
    const counts = this.db.prepare(`SELECT COUNT(*) AS total_events, COUNT(DISTINCT CASE WHEN source != 'unknown' THEN source END) AS sources,
      COUNT(DISTINCT NULLIF(session,'')) AS sessions, COALESCE(SUM(protocol='http'),0) AS http_events, COALESCE(SUM(protocol='ssh'),0) AS ssh_events FROM events`).get();
    const rows = this.db.prepare("SELECT substr(timestamp,1,13) || ':00:00.000Z' AS hour, COUNT(*) AS count FROM events WHERE timestamp >= ? GROUP BY hour").all(new Date(this.now() - 24 * 3600_000).toISOString());
    const byHour = new Map(rows.map(row => [row.hour, Number(row.count)]));
    const current = Math.floor(this.now() / 3600_000) * 3600_000;
    return {
      generated_at: new Date(this.now()).toISOString(), retention_days: this.retentionDays,
      ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
      events_per_hour: Array.from({length:24}, (_, i) => { const hour = new Date(current - (23 - i) * 3600_000).toISOString(); return {hour, count:byHour.get(hour) ?? 0}; }),
      top_paths: this.db.prepare("SELECT path, COUNT(*) AS count FROM events WHERE path != '' GROUP BY path ORDER BY count DESC LIMIT 6").all(),
      top_sources: this.db.prepare("SELECT source, COUNT(*) AS count FROM events WHERE source != 'unknown' GROUP BY source ORDER BY count DESC LIMIT 6").all(),
      categories: this.db.prepare('SELECT category, COUNT(*) AS count FROM events GROUP BY category ORDER BY count DESC').all(),
      recent: this.query({limit:12}).events,
    };
  }
  close() { this.db.close(); }
}
