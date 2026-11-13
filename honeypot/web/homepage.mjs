import { readFileSync } from 'node:fs';

const MAX_HOMEPAGE_BYTES = 256 * 1024;

// The repository-root page is canonical during development. Deployment contexts
// bake its exact bytes at the fixed fallback path; requests never select a file.
export function loadHomepage({
  canonical = new URL('../../index.html', import.meta.url),
  baked = new URL('./public/index.html', import.meta.url),
} = {}) {
  let bytes;
  try { bytes = readFileSync(canonical); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { bytes = readFileSync(baked); }
    catch (fallbackError) {
      if (fallbackError.code !== 'ENOENT') throw fallbackError;
      throw new Error('Homepage asset missing. Prepare it with scripts/build-containers.sh or scripts/image-context.py.');
    }
  }
  if (!bytes.length || bytes.length > MAX_HOMEPAGE_BYTES) throw new Error('Homepage must contain 1–262144 bytes');
  return bytes;
}

// Read once at module startup, not for every visitor or user-supplied path.
export const homepage = loadHomepage();
