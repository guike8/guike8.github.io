import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const required = ['dashboardHtml', 'dashboardScript'];

async function bundle() {
  const original = await readFile(new URL('src/ui.mjs', root), 'utf8');
  const exported = [...original.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map(match => match[1]);
  const ui = original.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '');
  if (/^(?:import|export)\s/m.test(ui) || required.some(name => !exported.includes(name))) {
    throw new Error('Unsupported dashboard UI module shape');
  }

  const originalEntry = await readFile(new URL('src/index.mjs', root), 'utf8');
  let imports = 0;
  const entry = originalEntry.replace(/^import\s*\{([^}\n]+)\}\s*from\s*['"]\.\/ui\.mjs['"];?\s*$/gm, (_line, names) => {
    const imported = names.split(',').map(name => name.trim()).filter(Boolean);
    if (imported.some(name => !required.includes(name))) throw new Error('Unsupported dashboard UI import');
    imports++;
    return '';
  });
  if (imports !== 1 || /^import\s/m.test(entry) || /\bimport\s*\(/.test(entry)) {
    throw new Error('Dashboard entry must import only the controlled UI module');
  }

  return '// Generated owner-private dashboard Worker. No local server.\n'
    + `const {${required.join(',')}} = (() => {\n${ui}\nreturn {${required.join(',')}};\n})();\n`
    + entry;
}

let output;
if (process.argv.length === 2) {
  output = fileURLToPath(new URL('dist/worker.mjs', root));
} else if (process.argv.length === 4 && process.argv[2] === '--bundle-worker' && isAbsolute(process.argv[3])) {
  output = process.argv[3];
} else {
  throw new Error('Usage: node scripts/build.mjs [--bundle-worker /absolute/output.mjs]');
}

const source = await bundle();
await mkdir(dirname(output), { recursive: true });
await writeFile(output, source);
console.log('Built the private dashboard Worker. No server was started.');
