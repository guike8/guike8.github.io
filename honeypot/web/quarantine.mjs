import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_SAMPLE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TOTAL_BYTES = 128 * 1024 * 1024;
export const DEFAULT_SAMPLE_COUNT = 256;
const MAX_CONCURRENT = 4;
const SAMPLE_NAME = /^[a-f0-9]{64}\.blob$/;
const TEMP_NAME = /^\.incoming-[a-f0-9-]{36}$/;

export class QuarantineError extends Error {
  constructor(statusCode, code) { super(code); this.name = 'QuarantineError'; this.statusCode = statusCode; this.code = code; }
}

/** Single-writer, content-addressed raw artifact storage. No parsing, execution or URL retrieval. */
export function createQuarantine(directory, {
  maxSampleBytes = DEFAULT_SAMPLE_BYTES, maxTotalBytes = DEFAULT_TOTAL_BYTES, maxSamples = DEFAULT_SAMPLE_COUNT,
} = {}) {
  for (const [value, ceiling] of [[maxSampleBytes, DEFAULT_SAMPLE_BYTES], [maxTotalBytes, DEFAULT_TOTAL_BYTES], [maxSamples, DEFAULT_SAMPLE_COUNT]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error('Invalid quarantine limits');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Quarantine must be a real directory');
  const samples = new Map();
  let totalBytes = 0;
  let reservedBytes = 0;
  let active = 0;
  // Recover crash leftovers; no sample or arbitrary path is ever removed here.
  for (const name of fs.readdirSync(directory)) {
    const full = path.join(directory, name);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected quarantine entry');
    if (TEMP_NAME.test(name)) { fs.unlinkSync(full); continue; }
    if (!SAMPLE_NAME.test(name) || stat.size < 1 || stat.size > maxSampleBytes) throw new Error('Unexpected quarantine entry');
    fs.chmodSync(full, 0o400);
    samples.set(name.slice(0, 64), stat.size);
    totalBytes += stat.size;
  }
  if (samples.size > maxSamples || totalBytes > maxTotalBytes) throw new Error('Existing quarantine exceeds capacity');

  return {
    stats() { return { samples: samples.size, bytes: totalBytes, active, reservedBytes, maxSampleBytes, maxTotalBytes, maxSamples }; },
    async capture(stream, { signal } = {}) {
      if (active >= MAX_CONCURRENT) throw new QuarantineError(429, 'upload_busy');
      if (signal?.aborted) throw new QuarantineError(408, 'upload_timeout');
      const header = stream.headers?.['content-length'];
      const expected = header === undefined ? null : Number(header);
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new QuarantineError(400, 'invalid_length');
      if (expected === 0) throw new QuarantineError(400, 'empty_artifact');
      if (expected !== null && expected > maxSampleBytes) throw new QuarantineError(413, 'artifact_too_large');
      const reservation = expected ?? maxSampleBytes;
      if (samples.size + active >= maxSamples || totalBytes + reservedBytes + reservation > maxTotalBytes) throw new QuarantineError(507, 'artifact_store_full');
      active++;
      reservedBytes += reservation;
      const temporary = path.join(directory, `.incoming-${randomUUID()}`);
      let handle;
      let size = 0;
      const hash = createHash('sha256');
      let aborted = false;
      const abort = () => {
        aborted = true;
        // Destroying the input releases an async iterator waiting for the next byte.
        setImmediate(() => { if (!stream.destroyed) stream.destroy(new QuarantineError(408, 'upload_timeout')); });
      };
      const ignoreStreamError = () => {};
      stream.on('error', ignoreStreamError);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        handle = await fs.promises.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        if (signal?.aborted) abort();
        for await (const value of stream.iterator({ destroyOnReturn: false })) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          size += chunk.length;
          if (size > maxSampleBytes || size > reservation) throw new QuarantineError(413, 'artifact_too_large');
          if (aborted || signal?.aborted) throw new QuarantineError(408, 'upload_timeout');
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        if (aborted || signal?.aborted) throw new QuarantineError(408, 'upload_timeout');
        if (size === 0) throw new QuarantineError(400, 'empty_artifact');
        if (expected !== null && size !== expected) throw new QuarantineError(400, 'incomplete_artifact');
        await handle.sync();
        await handle.chmod(0o400);
        await handle.close(); handle = undefined;
        if (aborted || signal?.aborted) throw new QuarantineError(408, 'upload_timeout');
        const sha256 = hash.digest('hex');
        const destination = path.join(directory, `${sha256}.blob`);
        let duplicate = false;
        try {
          // A hard link is an atomic exclusive publication; rename could overwrite a sample.
          fs.linkSync(temporary, destination);
          samples.set(sha256, size);
          totalBytes += size;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const stat = fs.lstatSync(destination);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size || !samples.has(sha256)) throw new Error('Quarantine collision');
          duplicate = true;
        }
        return { sha256, size, duplicate };
      } catch (error) {
        if (error instanceof QuarantineError) throw error;
        if (aborted || signal?.aborted) throw new QuarantineError(408, 'upload_timeout');
        if (stream.aborted || error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ECONNRESET') throw new QuarantineError(400, 'incomplete_artifact');
        throw new QuarantineError(503, 'artifact_store_unavailable');
      } finally {
        signal?.removeEventListener('abort', abort);
        if (handle) { try { await handle.close(); } catch {} }
        try {
          try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        } finally {
          active--;
          reservedBytes -= reservation;
          stream.removeListener('error', ignoreStreamError);
        }
      }
    },
  };
}
