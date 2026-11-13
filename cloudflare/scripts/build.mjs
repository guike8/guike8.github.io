import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {buildConfigurations} from './fixtures.mjs';

const root=new URL('../',import.meta.url);
const homepage=await readFile(new URL('../../index.html',import.meta.url));
const configs=buildConfigurations(homepage);
await mkdir(new URL('src/',root),{recursive:true});
await writeFile(new URL('src/homepage.mjs',root),'export default '+JSON.stringify(homepage.toString('utf8'))+';\n');
const routes=configs.service.commands.map((command,index)=>{
  const headers=Object.fromEntries(command.headers.map(header=>{const colon=header.indexOf(':');return [header.slice(0,colon),header.slice(colon+1).trim()];}));
  const type=headers['Content-Type'];
  delete headers['Content-Type'];
  // Header policy is owned centrally by the Worker, rather than upstream fixtures.
  for(const name of ['Content-Security-Policy','Cache-Control','Referrer-Policy','X-Content-Type-Options']) delete headers[name];
  return {pattern:command.regex,category:command.name.split(':')[0],status:command.statusCode,methods:command.methods,body:index===0?'__CANONICAL_HOMEPAGE__':command.handler,type,headers};
});
const source='import homepage from "./homepage.mjs";\nexport const routes='+JSON.stringify(routes).replace('"__CANONICAL_HOMEPAGE__"','homepage')+';\nexport const notFound='+JSON.stringify(configs.service.fallbackCommand.handler)+';\n';
await writeFile(new URL('src/routes.mjs',root),source);

// The connected Sites host accepts a single ESM Worker. Keep this small build
// dependency-free: each controlled source module gets its own lexical scope.
// Reject imports or unsupported export syntax instead of silently changing code.
async function scopedModule(name,required) {
  const original=await readFile(new URL('src/'+name,root),'utf8');
  const names=[...original.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map(match=>match[1]);
  const body=original.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm,'');
  if (/^(?:import|export)\s/m.test(body) || required.some(name=>!names.includes(name))) throw new Error('Unsupported module shape: '+name);
  return 'const {'+required.join(',')+'}=(()=>{\n'+body+'\nreturn {'+required.join(',')+'};\n})();\n';
}
if (process.argv[2]==='--bundle-worker' && process.argv.length===4) {
  const output=resolve(process.argv[3]);
  const telemetry=await scopedModule('telemetry.mjs',['recordEvent','readEvents','overview','pruneEvents']);
  const consoleModule=await scopedModule('console.mjs',['consoleHtml','consoleScript']);
  const entry=(await readFile(new URL('src/index.mjs',root),'utf8')).replace(/^import[^\n]+\n/gm,'');
  if (/^import\s/m.test(entry)) throw new Error('Unsupported Worker import');
  const fixtures=source.replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'');
  const bundle='// Generated from the guike8.github.io Cloudflare source. No local server.\nconst homepage='+JSON.stringify(homepage.toString('utf8'))+';\n'+fixtures+'\n'+telemetry+'\n'+consoleModule+'\n'+entry;
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,bundle);
  console.log('Built a single hosted Worker module.');
} else if (process.argv.length!==2) throw new Error('Usage: node scripts/build.mjs [--bundle-worker /absolute/output.js]');
console.log('Built canonical homepage and static decoy routes. No server was started.');
