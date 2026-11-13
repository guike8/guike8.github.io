import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventStore } from './store.mjs';
import { ingestDirectory } from './ingest.mjs';
import { createConsoleServer } from './server.mjs';

const token = readFileSync(process.env.CONSOLE_TOKEN_FILE ?? '/run/secrets/console_token', 'utf8').trim();
const dbPath = process.env.DB_PATH ?? '/data/events.sqlite';
mkdirSync(dirname(dbPath), {recursive:true, mode:0o750});
const retentionDays = Math.max(1, Math.min(30, Number(process.env.RETENTION_DAYS) || 7));
const store = new EventStore(dbPath, {retentionDays});
let state = {status:'starting', last_ingest_at:null, sources:{}};
function ingest() {
  const sources = {};
  let failed = false;
  const webDirectory = process.env.WEB_SOURCE_DIR ?? '/sources/web';
  const inputs = [
    ['http', process.env.BEELZEBUB_SOURCE_DIR ?? webDirectory, 'http'],
    ...(process.env.BEELZEBUB_SOURCE_DIR ? [['uploads', webDirectory, 'http']] : []),
    ['ssh', process.env.SSH_SOURCE_DIR ?? '/sources/ssh', 'ssh'],
  ];
  for (const [input, directory, protocol] of inputs) {
    try { sources[input] = {status:'ok', ...ingestDirectory(store, directory, protocol)}; }
    catch { sources[input] = {status:'error'}; failed = true; }
  }
  state = {status:failed ? 'degraded' : 'ok', last_ingest_at:new Date().toISOString(), sources};
}
ingest();
const poll = setInterval(ingest, 1500);
const prune = setInterval(() => {try {store.prune();} catch {state.status='degraded';}}, 60_000);
const server = createConsoleServer({store, token, quarantineDirectory:process.env.QUARANTINE_DIR, health:() => state});
server.listen(Number(process.env.CONSOLE_PORT) || 9090, process.env.CONSOLE_BIND ?? '127.0.0.1', () => console.log('Nightjar console ready'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  clearInterval(poll); clearInterval(prune);
  server.close(() => {store.close(); process.exit(0);});
  server.closeAllConnections();
});
