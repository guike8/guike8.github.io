import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { recordEvent, readEvents, overview, pruneEvents } from '../src/telemetry.mjs';

const DAY = 86_400_000;
const NOW = Date.now();
const TODAY = Math.floor(NOW / DAY);
const SCHEMA = readFileSync(new URL('../migrations/0001_events.sql', import.meta.url), 'utf8');

// A real SQLite adapter implementing only the D1 binding surface used by telemetry.
// It creates no listener or runtime and never reads request bodies.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  const statements = [];
  const DB = {
    prepare(sql) {
      statements.push(sql);
      return {
        args: [], sql,
        bind(...args) { this.args = args; return this; },
        async first() { return sqlite.prepare(sql).get(...this.args) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...this.args) }; },
        async run() {
          const result = sqlite.prepare(sql).run(...this.args);
          return { success: true, meta: { changes: Number(result.changes) } };
        }
      };
    },
    async batch(queries) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const query of queries) results.push(await query.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  return { sqlite, DB, statements, env: { DB, IP_HASH_KEY: '0123456789abcdef'.repeat(4) } };
}

function request(path = '/', headers = {}) {
  return new Request(`https://decoy.example${path}`, {
    headers: { 'CF-Connecting-IP': '192.0.2.42', 'CF-IPCountry': 'US', 'User-Agent': 'curl/8.5.0', ...headers }
  });
}

const detail = { category: 'reconnaissance', status: 404 };

function count(db, table = 'events') {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

// Seed synthetic SQL rows with distinct UUID-shaped identifiers; the production triggers still run.
function seed(db, number, day, start = 0) {
  const insert = db.prepare(`INSERT INTO events (id,timestamp_ms,method,path,category,status,source_hash,country,user_agent)
    VALUES (?, ?, 'GET', '/', 'discovery', 200, NULL, NULL, 'unknown')`);
  db.exec('BEGIN');
  try {
    for (let i = start; i < start + number; i++) {
      insert.run(`00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, day * DAY + (i % DAY));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

test('schema has no seed data, only one event secondary index, and initializes counters on admission', async () => {
  const { sqlite, env } = database();
  assert.equal(count(sqlite, 'telemetry_stats'), 0);
  assert.equal(count(sqlite, 'telemetry_days'), 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").get().n, 1);
  assert.equal(await recordEvent(env, request(), detail, NOW), true);
  assert.equal(sqlite.prepare('SELECT retained_count FROM telemetry_stats').get().retained_count, 1);
  assert.equal(sqlite.prepare('SELECT admitted_count FROM telemetry_days WHERE day=?').get(TODAY).admitted_count, 1);
  sqlite.close();
});

test('only bounded sanitized metadata is retained; bodies and authorization are never read', async () => {
  const { sqlite, env } = database();
  const req = request('/login/password/hunter2?token=never-store', {
    'User-Agent': 'curl/8.5.0 password=ua-secret Cookie: auth=ua-cookie',
    Authorization: 'Bearer auth-secret', Cookie: 'session=cookie-secret'
  });
  req.text = () => { throw new Error('body was read'); };
  req.json = () => { throw new Error('body was read'); };
  assert.equal(await recordEvent(env, req, detail, NOW), true);
  const event = (await readEvents(env)).events[0];
  assert.equal(event.path, '/login/password/[redacted]');
  assert.equal(event.user_agent, 'curl/8.5.0');
  assert.equal(event.country, 'US');
  assert.match(event.source_hash, /^[0-9a-f]{64}$/);
  const stored = JSON.stringify(event);
  for (const value of ['192.0.2.42', 'hunter2', 'never-store', 'ua-secret', 'ua-cookie', 'auth-secret', 'cookie-secret']) {
    assert.equal(stored.includes(value), false, value);
  }
  assert.deepEqual(Object.keys(event).sort(), ['category','country','id','method','path','source_hash','status','timestamp_ms','user_agent']);
  sqlite.close();
});

test('paths discard queries, redact encoded credentials and tokens, and cap output', async () => {
  const { sqlite, env } = database();
  const cases = [
    ['/username/alice/password/short?x=y', '/username/[redacted]/password/[redacted]'],
    ['/%2570assword/hidden%253Ftoken=bad', '/password/[redacted]'],
    ['/config%3Fpassword=bad', '/config'],
    ['/api/token=smallsecret', '/api/[redacted]'],
    ['/mail/alice@example.com', '/mail/[redacted]'],
    ['/key/eyJhbGciOiJIUzI1NiJ9.payload.signature', '/key/[redacted]'],
    ['/key/0123456789abcdef0123456789abcdef', '/key/[redacted]'],
    ['/api/%252570assword=bad', '/api/[redacted]'],
    ['https://user:pass@example.com/.env?secret=no', '/.env']
  ];
  for (const [path, expected] of cases) {
    assert.equal(await recordEvent(env, request(), { ...detail, path }, NOW), true);
    assert.equal(sqlite.prepare('SELECT path FROM events ORDER BY rowid DESC LIMIT 1').get().path, expected);
  }
  await recordEvent(env, request(), { ...detail, path: `/${'segment/'.repeat(100)}` }, NOW);
  assert.ok(sqlite.prepare('SELECT path FROM events ORDER BY rowid DESC LIMIT 1').get().path.length <= 160);
  sqlite.close();
});

test('IP hashes rotate by UTC day/key, normalize IPv6, and ignore forwarded headers', async () => {
  const { sqlite, env } = database();
  async function hash(ip, now = NOW, extra = {}) {
    const req = request('/', { 'CF-Connecting-IP': ip, ...extra });
    assert.equal(await recordEvent(env, req, detail, now), true);
    return sqlite.prepare('SELECT source_hash FROM events ORDER BY rowid DESC LIMIT 1').get().source_hash;
  }
  const a = await hash('2001:db8::1');
  assert.equal(a, await hash('2001:0db8:0000:0000:0000:0000:0000:0001'));
  assert.notEqual(a, await hash('2001:db8::1', (TODAY + 1) * DAY));
  env.IP_HASH_KEY = 'different-key-'.repeat(5);
  assert.notEqual(a, await hash('2001:db8::1'));
  for (const invalid of ['', '1.2.3.999', '01.2.3.4', '1.2.3.4:80', '1.2.3.4,5.6.7.8', '[2001:db8::1]', '2001:db8:::1', '2001::db8::1', 'a:b:c:d:e:f:1:2:3', 'fe80::1%eth0']) {
    assert.equal(await hash(invalid, NOW, { 'X-Forwarded-For': '192.0.2.99', 'X-Real-IP': '192.0.2.99' }), null, invalid);
  }
  assert.match(await hash('::ffff:192.0.2.42'), /^[0-9a-f]{64}$/);
  sqlite.close();
});

test('unrecognized user agents and invalid metadata cannot inject raw values', async () => {
  const { sqlite, env } = database();
  await recordEvent(env, request('/', { 'User-Agent': 'secret-user:secret-password', 'CF-IPCountry': 'XX-secret' }),
    { category: 'secret-category', status: 'password' }, NOW);
  const event = (await readEvents(env)).events[0];
  assert.equal(event.user_agent, 'unknown');
  assert.equal(event.country, null);
  assert.equal(event.category, 'other');
  assert.equal(event.status, null);
  sqlite.close();
});

test('the daily admission cap is atomic under parallel callers and survives deleting events', async () => {
  const { sqlite, env } = database();
  seed(sqlite, 4999, TODAY);
  const admitted = await Promise.all(Array.from({ length: 40 }, () => recordEvent(env, request(), detail, NOW)));
  assert.equal(admitted.filter(Boolean).length, 1);
  assert.equal(count(sqlite), 5000);
  sqlite.exec('DELETE FROM events');
  assert.equal(await recordEvent(env, request(), detail, NOW), false);
  assert.equal(await recordEvent(env, request(), detail, (TODAY + 1) * DAY), true);
  sqlite.close();
});

test('the retained hard cap remains atomic across day rollover and counter values stay accurate', async () => {
  const { sqlite, env } = database();
  for (let day = 0; day < 4; day++) seed(sqlite, day === 3 ? 4999 : 5000, TODAY - 4 + day, day * 5000);
  const admitted = await Promise.all(Array.from({ length: 30 }, () => recordEvent(env, request(), detail, NOW)));
  assert.equal(admitted.filter(Boolean).length, 1);
  assert.equal(count(sqlite), 20000);
  assert.equal(sqlite.prepare('SELECT retained_count FROM telemetry_stats WHERE id=1').get().retained_count, 20000);
  assert.equal(await recordEvent(env, request(), detail, (TODAY + 1) * DAY), false);
  sqlite.exec('DELETE FROM events WHERE rowid=(SELECT min(rowid) FROM events)');
  assert.equal(await recordEvent(env, request(), detail, NOW), true);
  assert.equal(count(sqlite), 20000);
  sqlite.close();
});

test('indexed cursor pagination is stable for equal timestamps and rejects injected cursors', async () => {
  const { sqlite, env, statements } = database();
  await Promise.all(Array.from({ length: 12 }, (_, i) => recordEvent(env, request(`/path-${i}`), detail, NOW)));
  const seen = [];
  let before;
  do {
    const page = await readEvents(env, { limit: 5, before });
    seen.push(...page.events.map(event => event.id));
    before = page.next_before;
  } while (before);
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12);
  assert.deepEqual(await readEvents(env, { before: '0); DROP TABLE events;--' }), { events: [], next_before: null });
  assert.equal(count(sqlite), 12);
  const query = statements.find(sql => sql.includes('WHERE (timestamp_ms, id)'));
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(NOW, seen[0], 6);
  assert.match(JSON.stringify(plan), /events_timestamp_id/);
  assert.doesNotMatch(JSON.stringify(plan), /USE TEMP B-TREE/);
  sqlite.close();
});

test('overview uses counters/index edges rather than scanning the retained table', async () => {
  const { sqlite, env, statements } = database();
  seed(sqlite, 3, TODAY - 1);
  await recordEvent(env, request(), detail, NOW);
  const summary = await overview(env);
  assert.equal(summary.available, true);
  assert.equal(summary.total_events, 4);
  assert.equal(summary.daily_events, 1);
  assert.equal(summary.daily_limit, 5000);
  assert.equal(summary.retained_limit, 20000);
  assert.equal(summary.last_event_ms, NOW);
  assert.equal(summary.first_event_ms, (TODAY - 1) * DAY);
  const sql = statements.at(-1);
  assert.doesNotMatch(sql, /COUNT\s*\(|GROUP BY|DISTINCT/i);
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(TODAY);
  assert.equal(plan.filter(row => /SCAN events(?! USING COVERING INDEX events_timestamp_id)/.test(row.detail)).length, 0);
  sqlite.close();
});

test('cleanup claims a 15 minute window and deletes at most 100 expired events/counter rows', async () => {
  const { sqlite, env } = database();
  seed(sqlite, 250, TODAY - 9);
  seed(sqlite, 2, TODAY, 1000);
  const results = await Promise.all(Array.from({ length: 10 }, () => pruneEvents(env, NOW)));
  assert.equal(results.filter(n => n > 0).length, 1);
  assert.equal(results.reduce((sum, n) => sum + n, 0), 100);
  assert.equal(count(sqlite), 152);
  assert.equal(sqlite.prepare('SELECT retained_count FROM telemetry_stats').get().retained_count, 152);
  assert.equal(count(sqlite, 'telemetry_days'), 1);
  assert.equal(await pruneEvents(env, NOW + 899999), 0);
  assert.equal(await pruneEvents(env, NOW + 900000), 100);
  assert.equal(await pruneEvents(env, NOW + 1800000), 50);
  assert.equal(count(sqlite), 2);
  assert.equal(sqlite.prepare('SELECT admitted_count FROM telemetry_days WHERE day=?').get(TODAY).admitted_count, 2);
  sqlite.close();
});

test('missing bindings, missing secret, invalid time, and quota errors fail softly', async () => {
  assert.equal(await recordEvent({}, request(), detail), false);
  assert.equal(await recordEvent({ DB: { prepare() { throw new Error('quota'); } }, IP_HASH_KEY: 'x'.repeat(32) }, request(), detail), false);
  const { sqlite, env } = database();
  assert.equal(await recordEvent({ DB: env.DB }, request(), detail), false);
  for (const now of [NaN, Infinity, -1, '123', 8_640_000_000_000_001]) assert.equal(await recordEvent(env, request(), detail, now), false);
  assert.equal(count(sqlite), 0);
  assert.deepEqual(await readEvents({}), { events: [], next_before: null });
  assert.equal((await overview({})).available, false);
  assert.equal(await pruneEvents({}), 0);
  const broken = { DB: { prepare() { throw new Error('quota'); }, batch() { throw new Error('quota'); } } };
  assert.deepEqual(await readEvents(broken), { events: [], next_before: null });
  assert.equal((await overview(broken)).available, false);
  assert.equal(await pruneEvents(broken), 0);
  sqlite.close();
});
