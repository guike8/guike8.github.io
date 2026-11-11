import { openSync, closeSync, readSync, fstatSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

// Byte cursors are committed in the same transaction as events. Inodes follow
// rotated files, so restarts and rename-based rotation don't duplicate sessions.
export function ingestDirectory(store, directory, protocol) {
  let files;
  try { files = readdirSync(directory).filter(name => /^events\.json(?:\.[0-9]+)?$/.test(name)); }
  catch (error) { if (error.code === 'ENOENT') return {files:0, records:0}; throw error; }
  let records = 0;
  for (const name of files) {
    const path = join(directory, name);
    let fd;
    try {
      if (!lstatSync(path).isFile()) continue;
      fd = openSync(path, 'r');
      const stat = fstatSync(fd);
      const identity = `${protocol}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let offset = store.cursor(identity);
      if (stat.size < offset) offset = 0;
      const buffer = Buffer.alloc(Math.min(262144, Math.max(0, stat.size - offset)));
      if (!buffer.length) continue;
      const size = readSync(fd, buffer, 0, buffer.length, offset);
      const last = buffer.lastIndexOf(10, size - 1);
      // A producer always emits short lines. Discard an oversized malformed line
      // in bounded chunks rather than allowing it to grow process memory.
      if (last === -1) {
        if (size === 262144) store.ingest(identity, offset + size, [], protocol);
        continue;
      }
      const batch = [];
      let start = 0;
      while (start <= last) {
        const end = buffer.indexOf(10, start);
        if (end < 0 || end > last) break;
        if (end - start <= 16384) {
          try { batch.push({raw:JSON.parse(buffer.subarray(start, end).toString('utf8')), position:offset+start}); }
          catch { /* Malformed source records are skipped, never evaluated. */ }
        }
        start = end + 1;
      }
      store.ingest(identity, offset + last + 1, batch, protocol);
      records += batch.length;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return { files:files.length, records };
}
