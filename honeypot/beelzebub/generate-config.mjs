import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_HOMEPAGE_BYTES = 256 * 1024;
export const TRUSTED_PROXY = '172.30.243.2/32';
const READ = ['GET', 'HEAD'];
const STYLE = ':root{font:15px system-ui,sans-serif;color:#26313b;background:#f3f5f6}*{box-sizing:border-box}body{margin:0}header{background:#202b35;color:#eef3f7;padding:22px max(24px,calc((100vw - 900px)/2))}header small{color:#acbbc8;margin-left:18px}main{max-width:900px;margin:42px auto;padding:0 24px}h1{font-size:28px}p{line-height:1.6;color:#61707c}.panel{background:white;border:1px solid #dbe1e5;border-radius:5px;padding:24px;margin:24px 0}a{color:#25658f}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:14px 0;border-bottom:1px solid #edf0f2}label{display:block;margin-top:18px}input{display:block;width:100%;margin-top:7px;padding:10px;border:1px solid #cbd4db;font:inherit}button{padding:11px 20px;margin-top:22px;background:#294f6c;color:white;border:0;font:inherit}.login{max-width:410px}footer{font-size:12px;color:#8b969f;margin-top:30px}code{font-family:ui-monospace,monospace}@media(max-width:600px){header small{display:block;margin:8px 0 0}main{margin-top:28px}}';
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Archive Console</title><style>${STYLE}</style></head><body><header><strong>ARCHIVE CONSOLE</strong><small>staging-02 / eu-west</small></header><main>${body}<footer>Archive Console 2.8.4 · Internal deployment</footer></main></body></html>\n`;
const LOGIN = page('Administration', '<div class="login"><h1>Administration</h1><p>Sign in to manage this staging deployment.</p><form class="panel" method="post" action="/admin/session" autocomplete="off"><label>Username<input name="username" maxlength="64" autocomplete="off" required></label><label>Password<input name="password" type="password" maxlength="128" autocomplete="off" required></label><button type="submit">Sign in</button><p>Staging credentials only. Production access is managed separately.</p></form><a href="/">Return to archive</a></div>');
const EXPIRED = page('Session unavailable', '<h1>Session unavailable</h1><p>The control plane is temporarily read only. Authentication could not be completed.</p><p><a href="/admin/">Try again</a> · <a href="/">Return to archive</a></p>');
const ARCHIVE = page('Export index', '<h1>Export index</h1><p>Retained snapshots for the staging migration.</p><section class="panel"><table><tr><th>File</th><th>Format</th><th>State</th></tr><tr><td><a href="/backup/staging-02.sql">staging-02.sql</a></td><td>SQL</td><td>retained</td></tr><tr><td><a href="/backup/manifest.json">manifest.json</a></td><td>JSON</td><td>verified</td></tr><tr><td><a href="/api/version">deployment.json</a></td><td>JSON</td><td>current</td></tr></table></section><a href="/upload">Artifact intake</a> · <a href="/">Return to archive</a>');
const NOT_FOUND = page('Not found', '<h1>Not found</h1><p>The requested resource is unavailable on this deployment.</p><a href="/">Return to archive</a>');
// These are synthetic fixtures. They are not deployment secrets or real accounts.
const ENV = '# Archive Console staging deployment\nAPP_NAME=archive-console\nAPP_ENV=staging\nAPP_VERSION=2.8.4\nAPP_HOST=staging-02\nDB_HOST=127.0.0.1\nDB_DATABASE=archive_staging\nDB_USERNAME=archive_demo\nDB_PASSWORD=synthetic-staging-only\nBACKUP_PATH=/backup/staging-02.sql\n';
const SQL = '-- Synthetic Archive Console staging export\nCREATE TABLE archive_jobs (id INTEGER, name TEXT, status TEXT);\nINSERT INTO archive_jobs VALUES (1, \'nightly-staging\', \'paused\');\nINSERT INTO archive_jobs VALUES (2, \'migration-check\', \'complete\');\n';
const ROBOTS = 'User-agent: *\nDisallow: /admin/\nDisallow: /backup/\nDisallow: /archive/\nDisallow: /api/internal/\nDisallow: /upload\n';
const json = value => JSON.stringify(value, null, 2) + '\n';
const query = '(?:\\?.*)?$';

function headers(type, extra = []) {
  return [
    `Content-Type: ${type}`, 'Server: nginx', 'Cache-Control: no-store',
    'X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer',
    "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  ];
}

function command(regex, category, statusCode, handler, type = 'text/html; charset=utf-8', methods = READ, extra = []) {
  return { regex, name: `${category}:${statusCode}`, ...(methods ? { methods } : {}), statusCode, handler, headers: headers(type, extra) };
}

export function buildConfigurations(homepage) {
  const bytes = Buffer.isBuffer(homepage) ? homepage : Buffer.from(homepage);
  if (!bytes.length || bytes.length > MAX_HOMEPAGE_BYTES) throw new Error('Homepage must contain 1–262144 bytes');
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!Buffer.from(body).equals(bytes)) throw new Error('Homepage must be canonical UTF-8 without a byte-order mark');
  const admin = '^/(?:admin(?:/[^?]*)?|login/?|wp-admin(?:/[^?]*)?|wp-login\\.php)' + query;
  const commands = [
    command('^/(?:index\\.html)?' + query, 'discovery', 200, body),
    command('^/robots\\.txt' + query, 'discovery', 200, ROBOTS, 'text/plain; charset=utf-8'),
    command('^/favicon\\.ico' + query, 'discovery', 204, ''),
    command('^/\\.env(?:\\.backup)?' + query, 'reconnaissance', 200, ENV, 'text/plain; charset=utf-8'),
    command('^/\\.git/HEAD' + query, 'reconnaissance', 200, 'ref: refs/heads/staging\n', 'text/plain; charset=utf-8'),
    command('^/\\.git/config' + query, 'reconnaissance', 200, '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = https://git.example.invalid/infrastructure/archive-console.git\n[branch "staging"]\n\tremote = origin\n\tmerge = refs/heads/staging\n', 'text/plain; charset=utf-8'),
    command('^/\\.git/refs/heads/staging' + query, 'reconnaissance', 200, 'd8a4e7d11a448d4effcbb4d8e4d98d7f7bb13c6c\n', 'text/plain; charset=utf-8'),
    command('^/(?:archive|backup)/?' + query, 'reconnaissance', 200, ARCHIVE),
    command('^/(?:backup/staging-02\\.sql|backup\\.sql)' + query, 'reconnaissance', 200, SQL, 'text/plain; charset=utf-8'),
    command('^/backup/manifest\\.json' + query, 'reconnaissance', 200, json({ deployment: 'staging-02', schema_version: 12, exports: [{ name: 'staging-02.sql', state: 'retained' }], retention: 'migration' }), 'application/json; charset=utf-8'),
    command('^/admin/unavailable' + query, 'authentication', 503, EXPIRED, 'text/html; charset=utf-8', READ, ['Retry-After: 3600']),
    command(admin, 'authentication', 200, LOGIN),
    command(admin, 'authentication', 303, EXPIRED, 'text/html; charset=utf-8', ['POST'], ['Location: /admin/unavailable']),
    command('^/api/(?:auth|login|session)(?:/[^?]*)?' + query, 'authentication', 303, EXPIRED, 'text/html; charset=utf-8', ['POST'], ['Location: /admin/unavailable']),
    command('^/(?:api/status|health|healthz)' + query, 'discovery', 200, json({ status: 'degraded', deployment: 'staging-02', mode: 'read-only', components: { archive: 'available', control: 'maintenance', tasks: 'paused' } }), 'application/json; charset=utf-8'),
    command('^/api/version' + query, 'discovery', 200, json({ service: 'archive-console', version: '2.8.4', branch: 'staging', schema_version: 12 }), 'application/json; charset=utf-8'),
    command('^/api/(?:internal/[^?]*|config)' + query, 'reconnaissance', 403, json({ error: 'access_denied', message: 'Control plane access is restricted during maintenance.' }), 'application/json; charset=utf-8'),
    command('(?i)(?:/cgi-bin/|/vendor/phpunit|/actuator(?:/|\\?|$)|/boaform|/HNAP1|\\.\\./|%2e|%252e|union(?:\\+|%20| )select|(?:%3c|<)script)', 'exploitation', 404, NOT_FOUND, 'text/html; charset=utf-8', null),
    command('^/api/', 'discovery', 404, json({ error: 'not_found', deployment: 'staging-02' }), 'application/json; charset=utf-8', null),
  ];
  return {
    core: { core: {
      logging: { debug: false, debugReportCaller: false, logDisableTimestamp: false, logsPath: '' },
      tracings: { 'rabbit-mq': { enabled: false, uri: '' } },
      prometheus: { enabled: false, path: '/metrics', port: ':2112' },
      'beelzebub-cloud': { enabled: false, uri: '', 'auth-token': '' },
    } },
    service: {
      apiVersion: 'v1', protocol: 'http', address: ':8080', description: 'Archive Console staging-02',
      serverName: 'staging-02', serverVersion: 'nginx', trustedProxies: [TRUSTED_PROXY], commands,
      fallbackCommand: { name: 'discovery:404', statusCode: 404, handler: NOT_FOUND, headers: headers('text/html; charset=utf-8') },
    },
  };
}

export async function generateConfigurations(homepagePath, outputPath) {
  const configurations = buildConfigurations(await readFile(homepagePath));
  await mkdir(resolve(outputPath, 'services'), { recursive: true });
  // JSON is a subset of YAML. It keeps canonical HTML newlines and Unicode exact,
  // while upstream's actual YAML parser/schema still validates every key.
  await writeFile(resolve(outputPath, 'core.yaml'), JSON.stringify(configurations.core, null, 2) + '\n', { mode: 0o644 });
  await writeFile(resolve(outputPath, 'services/http.yaml'), JSON.stringify(configurations.service, null, 2) + '\n', { mode: 0o644 });
  return configurations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [homepagePath, outputPath] = process.argv.slice(2);
  if (!homepagePath || !outputPath) throw new Error('Usage: node generate-config.mjs <staged-homepage> <output-directory>');
  await generateConfigurations(resolve(homepagePath), resolve(outputPath));
}
