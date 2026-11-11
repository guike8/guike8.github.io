import { createDecoyServer } from './server.mjs';
import { createRotatingLog } from './log.mjs';
import { createQuarantine } from './quarantine.mjs';

const port = Number(process.env.WEB_PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEB_PORT must be a valid TCP port');
let lastWarning = 0;
const log = createRotatingLog(process.env.WEB_LOG_PATH || '/telemetry/events.json', { onError() {
  if (Date.now() - lastWarning > 60000) { console.error('Web telemetry write failed; check volume capacity and permissions.'); lastWarning = Date.now(); }
} });
const quarantine = process.env.QUARANTINE_DIR ? createQuarantine(process.env.QUARANTINE_DIR) : undefined;
const server = createDecoyServer({ emit: event => log.emit(event), quarantine, trustedProxy: process.env.TRUSTED_PROXY === '1' });
server.listen(port, process.env.WEB_BIND || '0.0.0.0', () => console.log(`Decoy HTTP service listening on port ${port}`));
function stop() { server.closeClients(); server.close(() => { log.close(); process.exit(0); }); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
