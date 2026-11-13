#!/usr/bin/env node
// Exercise only this deployment with inert data. Does not scan other systems.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import https from 'node:https';

const web = process.env.HTTP_URL ?? 'http://127.0.0.1:80';
const tls = process.env.HTTPS_URL ?? 'https://127.0.0.1:443';
const consoleUrl = process.env.CONSOLE_URL ?? 'http://127.0.0.1:9090';
const token = readFileSync(new URL('../.secrets/console_token', import.meta.url), 'utf8').trim();
const headers = {Authorization:`Bearer ${token}`};
const userAgent = `Nightjar-Smoke/${randomUUID()}`;
const probeHeaders = {'User-Agent':userAgent};
const fixture = Buffer.from('Nightjar inert upload verification fixture. Never executable.\n');
const hash = createHash('sha256').update(fixture).digest('hex');
const home = await fetch(web+'/',{headers:probeHeaders});
assert.equal(home.status,200);
assert.deepEqual(Buffer.from(await home.arrayBuffer()),readFileSync(new URL('../web/public/index.html',import.meta.url)));
assert.equal((await fetch(web+'/.env?token=must-never-persist',{headers:probeHeaders})).status,200);
assert.equal((await fetch(web+'/admin/',{headers:{...probeHeaders,'X-Nightjar-Source':'203.0.113.99','X-Forwarded-For':'203.0.113.99'}})).status,200);
assert.equal((await fetch(web+'/admin/session',{method:'POST',headers:{...probeHeaders,Authorization:'Bearer must-never-persist',Cookie:'session=must-never-persist'},body:'username=verification&password=must-never-persist',redirect:'manual'})).status,303);
const upload = await fetch(web+'/api/upload',{method:'POST',headers:{...probeHeaders,'Content-Type':'application/octet-stream'},body:fixture});
assert.ok([200,201].includes(upload.status)); // A repeated inert fixture is deduplicated.
assert.ok((await upload.text()).includes(hash));
await new Promise((resolve,reject) => {
  https.get(tls+'/api/status',{rejectUnauthorized:false},res=> {res.resume(); res.on('end',()=>{try {assert.equal(res.statusCode,200);resolve();}catch(e){reject(e);}});}).on('error',reject);
});
await new Promise((resolve,reject) => {
  const socket = net.connect(Number(process.env.SSH_PORT)||2222,'127.0.0.1');
  socket.setTimeout(5000,()=>{socket.destroy();reject(new Error('SSH banner timeout'));});
  socket.once('data',data=> {socket.destroy();try {assert.ok(data.toString().startsWith('SSH-2.0-OpenSSH'));resolve();}catch(e){reject(e);}});
  socket.once('error',reject);
});
assert.equal((await fetch(consoleUrl+'/api/overview')).status,401);
let overview, currentEvents=[];
for (let i=0;i<30;i++) {
  overview=await (await fetch(consoleUrl+'/api/overview',{headers})).json();
  const results=await (await fetch(consoleUrl+'/api/events?limit=500',{headers})).json();
  currentEvents=results.events.filter(event=>event.user_agent===userAgent);
  if (currentEvents.length>=5 && overview.ssh_events>=1) break;
  await new Promise(resolve=>setTimeout(resolve,500));
}
assert.ok(overview.http_events>=4);
assert.ok(overview.ssh_events>=1);
assert.ok(currentEvents.length>=5);
assert.ok(currentEvents.some(event=>event.path==='/' && event.detail==='Beelzebub HTTP request'));
assert.ok(currentEvents.some(event=>event.path==='/api/upload' && event.category==='artifact'));
assert.ok(currentEvents.some(event=>event.path==='/.env' && event.category==='reconnaissance'));
const events=await (await fetch(consoleUrl+'/api/events?limit=500',{headers})).json();
assert.ok(!JSON.stringify(events).includes('must-never-persist'));
assert.ok(!events.events.some(event=>event.source==='203.0.113.99'));
const samples=await (await fetch(consoleUrl+'/api/samples',{headers})).json();
assert.ok(samples.samples.some(sample=>sample.sha256===hash && sample.size===fixture.length));
assert.equal((await fetch(web+'/'+hash+'.blob')).status,404);
console.log('Beelzebub homepage, HTTP/TLS/SSH ingress, source-header protection, private telemetry and inert sample capture passed.');
