import { dashboardHtml, dashboardScript } from './ui.mjs';

// Deploy only as an owner-private Sites app. Sites protects the HTML and every
// API route before this Worker is invoked. The collector itself stays public.
const SOURCE_ORIGIN='https://guike8-nightjar.seithargroup.chatgpt.site';
const MAX_BYTES=128*1024;
const CURSOR=/^(\d{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const headers={
  'Cache-Control':'private, no-store, max-age=0',
  'Pragma':'no-cache',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Cross-Origin-Resource-Policy':'same-origin',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};
function response(body,status=200,type='application/json; charset=utf-8',extra={}) {
  return new Response(body,{status,headers:{...headers,'Content-Type':type,...extra}});
}
function json(data,status=200) { return response(JSON.stringify(data),status); }
function validCursor(value) {
  const match=typeof value==='string'&&value.length<=100?CURSOR.exec(value):null;
  return !!match && Number.isSafeInteger(Number(match[1]));
}
function number(value) { return Number.isSafeInteger(value)&&value>=0?value:null; }
function timestamp(value) { const result=number(value);return result!==null&&result<=8640000000000000?result:null; }
function text(value,max) { return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f-\u009f]/g,'').slice(0,max):''; }
function projectOverview(data) {
  if(!data||data.available!==true) throw new Error('Source unavailable');
  const fields=['total_events','daily_events','daily_limit','retained_limit','retention_days'];
  if(fields.some(key=>number(data[key])===null)) throw new Error('Invalid source data');
  return {available:true,...Object.fromEntries(fields.map(key=>[key,data[key]])),first_event_ms:timestamp(data.first_event_ms),last_event_ms:timestamp(data.last_event_ms)};
}
function projectEvents(data) {
  if(!data||!Array.isArray(data.events)) throw new Error('Invalid source data');
  return {
    events:data.events.slice(0,50).map(event=>({
      id:text(event?.id,64),timestamp_ms:timestamp(event?.timestamp_ms),method:text(event?.method,16),path:text(event?.path,160),
      category:text(event?.category,32),status:Number.isInteger(event?.status)&&event.status>=100&&event.status<=599?event.status:null,
      user_agent:text(event?.user_agent,160),
    })),
    next_before:validCursor(data.next_before)?data.next_before:null,
  };
}

async function boundedJson(upstream,expired) {
  if(!upstream.ok || upstream.redirected || !/^application\/json(?:\s*;|$)/i.test(upstream.headers.get('Content-Type')??'')) {upstream.body?.cancel().catch(()=>{});throw new Error('Source unavailable');}
  if(Number(upstream.headers.get('Content-Length')??0)>MAX_BYTES) {upstream.body?.cancel().catch(()=>{});throw new Error('Response too large');}
  const reader=upstream.body?.getReader();
  if(!reader) throw new Error('No response data');
  const pieces=[];
  let length=0;
  try {
    for(;;){
      const {done,value}=await Promise.race([reader.read(),expired]);
      if(done) break;
      if(!(value instanceof Uint8Array)||(length+=value.byteLength)>MAX_BYTES) throw new Error('Response too large');
      pieces.push(value);
    }
    const all=new Uint8Array(length);
    let offset=0;
    for(const piece of pieces){all.set(piece,offset);offset+=piece.byteLength;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));
  } finally { reader.cancel().catch(()=>{}); }
}

export function createDashboard({fetcher=(...args)=>globalThis.fetch(...args),timeoutMs=5000}={}) {
  return {async fetch(request,env={}) {
    request.body?.cancel().catch(()=>{});
    if(!['GET','HEAD'].includes(request.method)) return json({error:'method_not_allowed'},405);
    let url;
    try{url=new URL(request.url);}catch{return json({error:'bad_request'},400);}
    if(request.url.length>4096) return json({error:'invalid_query'},400);
    if(url.pathname==='/'||url.pathname==='/index.html') return response(request.method==='HEAD'?null:dashboardHtml,200,'text/html; charset=utf-8');
    if(url.pathname==='/app.js') return response(request.method==='HEAD'?null:dashboardScript,200,'text/javascript; charset=utf-8');
    if(!['/api/overview','/api/events'].includes(url.pathname)) return json({error:'not_found'},404);
    if((request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin)||request.headers.get('Sec-Fetch-Site')==='cross-site') return json({error:'forbidden'},403);
    const keys=[...url.searchParams.keys()];
    if(keys.some(key=>!['limit','before'].includes(key))||new Set(keys).size!==keys.length) return json({error:'invalid_query'},400);
    if(url.pathname==='/api/overview'&&keys.length) return json({error:'invalid_query'},400);
    const limit=url.searchParams.get('limit')??'50';
    const before=url.searchParams.get('before');
    if(!/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit)||(before!==null&&!validCursor(before))) return json({error:'invalid_query'},400);
    if(request.method==='HEAD') return response(null);
    if(typeof env.HONEYPOT_ADMIN_TOKEN!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(env.HONEYPOT_ADMIN_TOKEN)) return json({error:'source_unavailable'},503);
    const endpoint=url.pathname==='/api/events'?'/_nightjar/api/events':'/_nightjar/api/overview';
    const target=new URL(endpoint,SOURCE_ORIGIN);
    if(url.pathname==='/api/events'){
      target.searchParams.set('limit',limit);
      if(before!==null) target.searchParams.set('before',before);
    }
    const controller=new AbortController();
    let timer;
    const expired=new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Source timeout'));},timeoutMs);});
    const authHeaders={'Authorization':'Bearer '+env.HONEYPOT_ADMIN_TOKEN,'Accept':'application/json','Cache-Control':'no-store','User-Agent':'Nightjar-Private-Dashboard/1.0'};
    // Optional existing Sites service access is consumed by the source dispatch;
    // it is never exposed to the browser or accepted from request headers.
    if(typeof env.HONEYPOT_SERVICE_TOKEN==='string'&&/^[\x21-\x7e]{16,4096}$/.test(env.HONEYPOT_SERVICE_TOKEN)) authHeaders['OAI-Sites-Authorization']='Bearer '+env.HONEYPOT_SERVICE_TOKEN;
    let upstreamStatus=null;
    try {
      // Workers supports manual redirects, not redirect:'error'. Every 3xx is
      // rejected by boundedJson, so credentials never follow a redirect.
      const upstream=await Promise.race([fetcher(target.href,{method:'GET',headers:authHeaders,redirect:'manual',signal:controller.signal}),expired]);
      upstreamStatus=upstream.status;
      const data=await boundedJson(upstream,expired);
      return json(url.pathname==='/api/events'?projectEvents(data):projectOverview(data));
    } catch(error) {
      // Operational diagnostics contain no URLs, credentials, request metadata,
      // upstream bodies, or exception messages. Browser failures stay generic.
      console.error('Nightjar source read failed', {kind:error instanceof Error?error.name:'unknown',upstream_status:upstreamStatus});
      return json({error:'source_unavailable'},503);
    }
    finally {clearTimeout(timer);controller.abort();}
  }};
}

export default createDashboard();
