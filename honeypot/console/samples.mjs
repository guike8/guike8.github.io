import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

// The console lists metadata only. It has no handler that reads or serves bytes.
export function sampleInventory(directory) {
  const limits = {max_total_bytes:134217728, max_sample_bytes:2097152, max_samples:256};
  if (!directory) return {...limits, available:false, total_bytes:0, samples:[]};
  try {
    const samples = [];
    for (const name of readdirSync(directory).slice(0, 1024)) {
      if (!/^[a-f0-9]{64}\.blob$/.test(name)) continue;
      try {
        const stat = lstatSync(join(directory, name));
        if (!stat.isFile()) continue;
        samples.push({sha256:name.slice(0,64), size:stat.size, first_seen:stat.mtime.toISOString()});
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    samples.sort((a,b) => b.first_seen.localeCompare(a.first_seen));
    return {...limits, available:true, total_bytes:samples.reduce((n,s) => n+s.size,0), samples:samples.slice(0,256)};
  } catch (error) {
    if (error.code === 'ENOENT') return {...limits, available:false, total_bytes:0, samples:[]};
    throw error;
  }
}
