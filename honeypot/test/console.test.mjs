import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, normalizeEvent } from '../console/store.mjs';
import { ingestDirectory } from '../console/ingest.mjs';
import { createConsoleServer } from '../console/server.mjs';
import { sampleInventory } from '../console/samples.mjs';

const NOW = Date.parse('2026-11-11T15:00:00.000Z');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nightjar-console-'));
  const store = new EventStore(join(dir,'test.sqlite'), {now:()=>NOW});
  t.after(() => {store.close(); rmSync(dir,{recursive:true,force:true});});
  return {dir,store};
}
const httpEvent = (path='/admin/') => ({timestamp:new Date(NOW).toISOString(), event:'http.request', source_ip:'203.0.113.8',method:'GET',path,category:'authentication',status:200,user_agent:'curl/8',detail:'Authentication endpoint'});

test('normalization drops password and raw request fields and bounds untrusted data', () => {
  const event = normalizeEvent({...httpEvent('/admin/?password=secret'), password:'do-not-store', authorization:'secret', user_agent:'Bearer hidden-value',detail:'password="hidden password"\n<script>x</script>'}, 'http', 'one', NOW);
  assert.equal(event.path,'/admin/');
  assert.equal(event.user_agent,'Bearer [redacted]');
  assert.ok(!JSON.stringify(event).includes('hidden password'));
  assert.ok(!JSON.stringify(event).includes('do-not-store'));
  assert.equal(event.source,'203.0.113.8');
  const ssh = normalizeEvent({timestamp:new Date(NOW).toISOString(),eventid:'cowrie.login.success',src_ip:'not-an-ip',password:'actual-password',username:'root',message:'actual-password'},'ssh','two',NOW);
  assert.equal(ssh.source,'unknown');
  assert.equal(ssh.detail,'username: root');
  assert.ok(!JSON.stringify(ssh).includes('actual-password'));
  assert.equal(normalizeEvent({eventid:'unknown.event',password:'secret'},'ssh','x',NOW),null);
  assert.equal(normalizeEvent({eventid:'cowrie.sensor.dropped',count:123,password:'secret'},'ssh','d',NOW).detail,'123 events dropped by rate limit');
});

test('byte cursors survive partial lines, rotation and database reopen without duplicates', t => {
  const {dir,store} = fixture(t);
  const logs = join(dir,'logs'); mkdirSync(logs);
  const file = join(logs,'events.json');
  const first = JSON.stringify(httpEvent('/one'));
  const second = JSON.stringify(httpEvent('/two'));
  writeFileSync(file, first+'\n'+second.slice(0,20));
  ingestDirectory(store,logs,'http');
  assert.equal(store.query().total,1);
  appendFileSync(file,second.slice(20)+'\n');
  ingestDirectory(store,logs,'http');
  renameSync(file,file+'.1');
  writeFileSync(file,JSON.stringify(httpEvent('/three'))+'\n');
  ingestDirectory(store,logs,'http');
  ingestDirectory(store,logs,'http');
  assert.equal(store.query().total,3);
  // Independent connection simulates collector restart while preserving byte cursors.
  const reopened = new EventStore(join(dir,'test.sqlite'),{now:()=>NOW});
  ingestDirectory(reopened,logs,'http');
  assert.equal(reopened.query().total,3);
  reopened.close();
});

test('retention, event cap and parameterized literal search produce bounded results', t => {
  const {store} = fixture(t);
  store.add({...httpEvent('/old'),timestamp:new Date(NOW-8*86400_000).toISOString()});
  store.add(httpEvent('/admin/%_'));
  store.add(httpEvent('/other'));
  assert.equal(store.query({q:'%_'}).total,1);
  assert.equal(store.query({q:"' OR 1=1 --"}).total,0);
  store.prune();
  assert.equal(store.query().total,2);
  store.maxEvents=1; store.prune();
  assert.equal(store.query().total,1);
  assert.equal(store.overview().events_per_hour.length,24);
  assert.equal(store.overview().events_per_hour.at(-1).count,1);
});

test('sample inventory ignores arbitrary names and symbolic links without reading bytes', t => {
  const {dir} = fixture(t);
  const samples=join(dir,'samples'); mkdirSync(samples);
  const hash='a'.repeat(64);
  writeFileSync(join(samples,hash+'.blob'),'inert fixture');
  writeFileSync(join(samples,'ignore.txt'),'not-a-sample');
  symlinkSync(join(samples,'ignore.txt'),join(samples,'b'.repeat(64)+'.blob'));
  const inventory=sampleInventory(samples);
  assert.equal(inventory.samples.length,1);
  assert.equal(inventory.samples[0].sha256,hash);
  assert.equal(inventory.total_bytes,13);
  assert.equal(inventory.max_total_bytes,128*1024*1024);
});

test('private API requires bearer auth, rejects cross-site calls, serves no sample bytes', async t => {
  const {dir,store}=fixture(t);
  store.add(httpEvent('/.env'));
  const token='test-token-'.repeat(5);
  const server=createConsoleServer({store,token,quarantineDirectory:dir});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:`Bearer ${token}`};
  assert.equal((await fetch(base+'/api/overview')).status,401);
  assert.equal((await fetch(base+'/api/overview?token='+token)).status,401);
  const result=await fetch(base+'/api/overview',{headers});
  assert.equal(result.status,200);
  assert.equal((await result.json()).total_events,1);
  assert.ok(result.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal((await fetch(base+'/api/overview',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await fetch(base+'/api/events?protocol=bad',{headers})).status,400);
  assert.equal((await fetch(base+'/api/samples',{headers})).status,200);
  assert.equal((await fetch(base+'/samples/'+ 'a'.repeat(64)+'.blob',{headers})).status,404);
  const output=await (await fetch(base+'/api/export',{headers})).text();
  assert.equal(JSON.parse(output).path,'/.env');
  const home=await fetch(base+'/');
  assert.equal(home.status,200);
  assert.ok(!(await home.text()).includes(token));
  assert.equal((await fetch(base+'/api/events',{method:'POST',headers})).status,405);
});
