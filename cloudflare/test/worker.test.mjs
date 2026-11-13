import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handleRequest,authorized} from '../src/index.mjs';

const origin='https://nightjar.example';
const secret='a'.repeat(64);
const request=(path,options={})=>new Request(origin+path,options);
const noStorage={DB:{prepare(){throw new Error('Database must not be called');}}};

test('homepage and HEAD preserve the canonical red profile without a local listener',async()=>{
  const response=await handleRequest(request('/'));
  assert.equal(response.status,200);
  assert.equal(await response.text(),readFileSync(new URL('../../index.html',import.meta.url),'utf8'));
  assert.equal(await (await handleRequest(request('/index.html',{method:'HEAD'}))).text(),'');
  assert.match(response.headers.get('Content-Security-Policy'),/default-src 'none'/);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});

test('static recon and authentication decoys never reflect visitor credentials',async()=>{
  assert.equal((await handleRequest(request('/.env'))).status,200);
  assert.equal(await (await handleRequest(request('/.git/HEAD'))).text(),'ref: refs/heads/staging\n');
  const response=await handleRequest(request('/admin/session?token=never-persist',{method:'POST',headers:{Authorization:'Bearer never-persist',Cookie:'session=never-persist'},body:'password=never-persist'}));
  assert.equal(response.status,303);
  assert.equal(response.headers.get('Location'),'/admin/unavailable');
  assert.ok(!(await response.text()).includes('never-persist'));
});

test('submitted bodies are cancelled without being read, and uploads are not accepted',async()=>{
  let cancelled=false;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  const response=await handleRequest(request('/api/upload',{method:'POST',body,duplex:'half'}));
  assert.equal(response.status,503);
  assert.equal(cancelled,true);
  assert.equal((await response.json()).error,'intake_unavailable');
});

test('malformed targets and declared oversized requests produce fixed bounded replies',async()=>{
  assert.equal((await handleRequest(request('/%ZZ'))).status,400);
  assert.equal((await handleRequest(request('/'+ 'a'.repeat(4100)))).status,414);
  assert.equal((await handleRequest(request('/admin/',{method:'POST',headers:{'Content-Length':'8193'}}))).status,413);
  assert.equal((await handleRequest(request('/missing'))).status,404);
});

test('private APIs fail closed before database access, including absent secrets',async()=>{
  for(const path of ['/_nightjar/api/events','/_nightjar/api/overview']){
    assert.equal((await handleRequest(request(path),noStorage)).status,401);
    assert.equal((await handleRequest(request(path,{headers:{Authorization:'Bearer '+ 'b'.repeat(64)}}),{...noStorage,ADMIN_TOKEN:secret})).status,401);
  }
  assert.equal(await authorized(request('/',{headers:{Authorization:'Bearer '+secret}}),{ADMIN_TOKEN:secret}),true);
  assert.equal(await authorized(request('/',{headers:{Authorization:'Bearer '+secret+', Bearer '+secret}}),{ADMIN_TOKEN:secret}),false);
  assert.equal(await authorized(request('/'),{ADMIN_TOKEN:''}),false);
});

test('private APIs reject cross-site and mutating calls even with a valid token',async()=>{
  const env={...noStorage,ADMIN_TOKEN:secret};
  const response=await handleRequest(request('/_nightjar/api/events',{headers:{Authorization:'Bearer '+secret,Origin:'https://other.example'}}),env);
  assert.equal(response.status,403);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
  assert.equal((await handleRequest(request('/_nightjar/api/events',{method:'POST',headers:{Authorization:'Bearer '+secret}}),env)).status,405);
});

test('an authenticated API with no D1 returns unavailable instead of invented events',async()=>{
  const response=await handleRequest(request('/_nightjar/api/overview',{headers:{Authorization:'Bearer '+secret}}),{ADMIN_TOKEN:secret});
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'storage_unavailable'});
});
