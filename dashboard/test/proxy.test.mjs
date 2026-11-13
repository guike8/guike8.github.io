import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboard} from '../src/index.mjs';

const base='https://dashboard.example';
const secret='a'.repeat(43);
const env={HONEYPOT_ADMIN_TOKEN:secret};
const req=(path,options={})=>new Request(base+path,options);
const overview={available:true,total_events:14,daily_events:14,daily_limit:5000,retained_limit:20000,retention_days:7,first_event_ms:100,last_event_ms:200};
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});

test('default fetch preserves its runtime receiver and uses portable request options',async()=>{
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async function(url,init){
    assert.equal(this,globalThis);
    assert.equal(init.cache,undefined);
    assert.equal(init.redirect,'manual');
    assert.equal(init.headers['Cache-Control'],'no-store');
    calls++;
    return json(overview);
  };
  try {
    const response=await createDashboard().fetch(req('/api/overview'),env);
    assert.equal(response.status,200);
    assert.equal(calls,1);
  } finally {globalThis.fetch=original;}
});

test('fixed-origin proxy uses only server credentials and projects bounded metadata',async()=>{
  let received;
  const api=createDashboard({fetcher:async(url,init)=>{received={url,init};return json({events:[{id:'id',timestamp_ms:100,method:'GET',path:'/<script>',category:'discovery',status:200,user_agent:'curl/8.0',authorization:'must-not-leak',source_hash:'hidden',country:'hidden'}],next_before:null,secret:'must-not-leak'});}});
  const response=await api.fetch(req('/api/events?limit=10',{headers:{Authorization:'Bearer attacker',Cookie:'private=must-not-forward','X-Forwarded-Host':'attacker.example'}}),env);
  assert.equal(response.status,200);
  assert.equal(received.url,'https://guike8-nightjar.seithargroup.chatgpt.site/_nightjar/api/events?limit=10');
  assert.equal(received.init.headers.Authorization,'Bearer '+secret);
  assert.equal(received.init.headers.Cookie,undefined);
  assert.equal(received.init.headers['X-Forwarded-Host'],undefined);
  assert.equal(received.init.redirect,'manual');
  const body=await response.text();
  assert.ok(!body.includes('must-not-leak')&&!body.includes('hidden')&&!body.includes(secret));
  assert.match(body,/<script>/); // The client renders metadata as text.
});

test('HTML and browser script contain no server credential and do not fetch the source',async()=>{
  const api=createDashboard({fetcher:()=>{throw new Error('Unexpected source request');}});
  for(const path of ['/','/app.js']){
    const response=await api.fetch(req(path),env);
    assert.equal(response.status,200);
    const body=await response.text();
    assert.ok(!body.includes(secret)&&!body.includes('HONEYPOT_ADMIN_TOKEN'));
    assert.match(response.headers.get('Cache-Control'),/private, no-store/);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
    assert.match(response.headers.get('Content-Security-Policy'),/script-src 'self'/);
  }
});

test('mutating methods, unknown routes, forged origins and unsupported queries never fetch',async()=>{
  let calls=0;
  const api=createDashboard({fetcher:()=>{calls++;throw new Error('Unexpected source request');}});
  assert.equal((await api.fetch(req('/api/events',{method:'POST'}),env)).status,405);
  assert.equal((await api.fetch(req('/api/source?url=https://attacker.example'),env)).status,404);
  assert.equal((await api.fetch(req('/api/events',{headers:{Origin:'https://attacker.example'}}),env)).status,403);
  assert.equal((await api.fetch(req('/api/events',{headers:{'Sec-Fetch-Site':'cross-site'}}),env)).status,403);
  for(const query of ['limit=51','limit=-1','limit=1&limit=2','before=1:x','before=https://attacker.example','before=','url=https://attacker.example','limit=01']){
    assert.equal((await api.fetch(req('/api/events?'+query),env)).status,400,query);
  }
  assert.equal((await api.fetch(req('/api/overview?limit=1'),env)).status,400);
  assert.equal(calls,0);
});

test('overview projection and cursor forwarding preserve the source contract',async()=>{
  const cursor='1794568531366:9e530d8b-dfce-4bd8-af82-e439c00b7d87';
  const calls=[];
  const api=createDashboard({fetcher:async url=>{calls.push(url);return url.includes('/overview')?json({...overview,admin:'never-return'}):json({events:[],next_before:cursor});}});
  const a=await api.fetch(req('/api/overview'),env);
  assert.deepEqual(await a.json(),overview);
  const b=await api.fetch(req('/api/events?before='+encodeURIComponent(cursor)),env);
  assert.deepEqual(await b.json(),{events:[],next_before:cursor});
  assert.equal(new URL(calls[1]).searchParams.get('before'),cursor);
  assert.equal(new URL(calls[1]).origin,'https://guike8-nightjar.seithargroup.chatgpt.site');
});

test('missing credentials, source errors, redirects and malformed JSON return generic failures',async()=>{
  for(const response of [new Response('private details',{status:401}),new Response('redirect',{status:302,headers:{Location:'https://attacker.example'}}),new Response('bad json',{headers:{'Content-Type':'application/json'}}),json({available:false})]){
    const api=createDashboard({fetcher:async()=>response});
    const result=await api.fetch(req('/api/overview'),env);
    assert.equal(result.status,503);
    assert.deepEqual(await result.json(),{error:'source_unavailable'});
  }
  const api=createDashboard({fetcher:()=>{throw new Error(secret);}});
  assert.equal((await api.fetch(req('/api/overview'),{})).status,503);
  assert.equal((await api.fetch(req('/api/overview'),env)).status,503);
});

test('actual streamed bytes are capped without trusting content length',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(128*1024+1));},cancel(){cancelled=true;}});
  const api=createDashboard({fetcher:async()=>new Response(stream,{headers:{'Content-Type':'application/json','Content-Length':'1'}})});
  assert.equal((await api.fetch(req('/api/events'),env)).status,503);
  assert.equal(cancelled,true);
});

test('timeout remains active while the upstream body stalls after its headers',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({cancel(){cancelled=true;}});
  const api=createDashboard({timeoutMs:10,fetcher:async()=>new Response(stream,{headers:{'Content-Type':'application/json'}})});
  assert.equal((await api.fetch(req('/api/events'),env)).status,503);
  assert.equal(cancelled,true);
});

test('HEAD is metadata-only and cannot consume source read quotas',async()=>{
  let calls=0;
  const api=createDashboard({fetcher:()=>{calls++;throw new Error('Unexpected source request');}});
  const response=await api.fetch(req('/api/events',{method:'HEAD'}),env);
  assert.equal(response.status,200);
  assert.equal(await response.text(),'');
  assert.equal(calls,0);
});
