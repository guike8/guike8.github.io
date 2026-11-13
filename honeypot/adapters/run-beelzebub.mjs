import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBeelzebubAdapter, createBoundedLineDecoder } from './beelzebub.mjs';
import { createRotatingLog } from '../web/log.mjs';

/** Credentials and arbitrary BEELZEBUB_* overrides are never inherited. */
export function childEnvironment() {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp', TZ: 'UTC',
    GOMEMLIMIT: '64MiB', GOMAXPROCS: '1',
    BEELZEBUB_LOGGING_DEBUG: 'false', BEELZEBUB_LOGGING_DEBUG_REPORT_CALLER: 'false',
    BEELZEBUB_LOGGING_LOGS_PATH: '', BEELZEBUB_CLOUD_ENABLED: 'false',
    BEELZEBUB_RABBITMQ_ENABLED: 'false', BEELZEBUB_PROMETHEUS_ENABLED: 'false',
  };
}

/** Child raw output exists only in pipes. All diagnostics use fixed messages. */
export function superviseBeelzebub({ binary, args = [], emit, diagnostic = () => {}, trustedProxy = false, cwd = '/tmp', environment = childEnvironment() }) {
  if (!isAbsolute(binary) || !Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('Invalid runtime command');
  const stdout = createBeelzebubAdapter({ emit, diagnostic, trustedProxy });
  const stderr = createBoundedLineDecoder({ onLine: () => diagnostic('suppressed'), onDiscard: () => diagnostic('suppressed') });
  const child = spawn(binary, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
  child.stdout.on('data', bytes => stdout.write(bytes));
  child.stderr.on('data', bytes => stderr.write(bytes));
  child.stdout.on('error', () => diagnostic('suppressed'));
  child.stderr.on('error', () => diagnostic('suppressed'));
  child.on('error', () => diagnostic('runtime'));
  let killTimer;
  const done = new Promise(resolve => child.once('close', (code, signal) => {
    clearTimeout(killTimer);
    stdout.end(); stderr.end();
    resolve({ code: Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1, signal });
  }));
  return {
    done,
    stop(signal = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      if (!killTimer) { killTimer = setTimeout(() => child.kill('SIGKILL'), 3000); killTimer.unref(); }
    },
  };
}

async function main() {
  let lastDiagnostic = 0;
  function diagnostic(reason) {
    const now = Date.now();
    if (now - lastDiagnostic < 30_000) return;
    lastDiagnostic = now;
    console.error(reason === 'storage' ? 'Beelzebub telemetry storage needs attention.' : reason === 'runtime' ? 'Beelzebub runtime could not start.' : 'Beelzebub diagnostic output suppressed.');
  }
  const spool = createRotatingLog(process.env.BEELZEBUB_LOG_PATH || '/telemetry/events.json', { onError: () => diagnostic('storage') });
  const runtime = superviseBeelzebub({
    binary: process.env.BEELZEBUB_BINARY || '/usr/local/bin/beelzebub',
    args: ['run', '--mem-limit-mib', '64', '--conf-core', '/app/beelzebub/generated/core.yaml', '--conf-services', '/app/beelzebub/generated/services'],
    emit: event => spool.emit(event), diagnostic,
    trustedProxy: process.env.TRUSTED_PROXY === '1',
  });
  const stop = () => runtime.stop();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const result = await runtime.done;
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  spool.close();
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Beelzebub wrapper initialization failed.'); process.exitCode = 1; });
}
