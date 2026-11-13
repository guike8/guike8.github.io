import fs from 'node:fs';
import path from 'node:path';

/** Bounded local NDJSON spool. One writer per file; collector reads the shared directory. */
export function createRotatingLog(filename, { maxBytes = 5 * 1024 * 1024, files = 3, onError = () => {} } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || !Number.isSafeInteger(files) || files < 1 || files > 10) throw new Error('Invalid rotation limits');
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o750 });
  let fd;
  let size = 0;
  function open() {
    fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o640);
    size = fs.fstatSync(fd).size;
  }
  open();
  function rotate() {
    fs.closeSync(fd); fd = undefined;
    for (let i = files - 1; i >= 1; i--) {
      const from = i === 1 ? filename : `${filename}.${i - 1}`;
      const to = `${filename}.${i}`;
      try { fs.renameSync(from, to); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (files === 1) fs.rmSync(filename, { force: true });
    open();
  }
  return {
    emit(event) {
      try {
        const line = Buffer.from(JSON.stringify(event) + '\n');
        if (line.byteLength > 4096) throw new Error('Telemetry event exceeded size limit');
        if (fd === undefined) open();
        if (size + line.byteLength > maxBytes) rotate();
        fs.writeSync(fd, line); size += line.byteLength;
      } catch { onError(); }
    },
    close() { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } },
  };
}
