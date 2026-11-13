import { routes, notFound } from './routes.mjs';
import { consoleHtml, consoleScript } from './console.mjs';
import { recordEvent, readEvents, overview, pruneEvents } from './telemetry.mjs';

const compiled = routes.map(route => ({...route, matcher:new RegExp(route.pattern.replace(/^\(\?i\)/, ''), route.pattern.startsWith('(?i)') ? 'i' : '')}));
const securityHeaders = {
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const consolePolicy = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

function reply(body, status=200, type='text/html; charset=utf-8', extra={}, head=false) {
  return new Response(head || status===204 || status===304 ? null : body, {status,headers:{...securityHeaders,'Content-Type':type,...extra}});
}
function json(value, status=200, head=false) { return reply(JSON.stringify(value),status,'application/json; charset=utf-8',{},head); }
function discardBody(request) { if (request.body) request.body.cancel().catch(()=>{}); }

export async function authorized(request, env) {
  if (typeof env.ADMIN_TOKEN!=='string' || env.ADMIN_TOKEN.length<32 || env.ADMIN_TOKEN.length>256) return false;
  const value=request.headers.get('Authorization') ?? '';
  if (!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(value)) return false;
  const encode=new TextEncoder();
  const [a,b]=await Promise.all([
    crypto.subtle.digest('SHA-256',encode.encode(value.slice(7))),
    crypto.subtle.digest('SHA-256',encode.encode(env.ADMIN_TOKEN)),
  ]);
  const left=new Uint8Array(a),right=new Uint8Array(b);
  let difference=0;
  for(let i=0;i<left.length;i++) difference|=left[i]^right[i];
  return difference===0;
}

async function privateRoute(request,env,url) {
  const head=request.method==='HEAD';
  if (!['GET','HEAD'].includes(request.method)) return json({error:'method_not_allowed'},405);
  if (url.pathname==='/_nightjar' || url.pathname==='/_nightjar/') return reply(consoleHtml,200,undefined,{'Content-Security-Policy':consolePolicy},head);
  if (url.pathname==='/_nightjar/app.js') return reply(consoleScript,200,'text/javascript; charset=utf-8',{'Content-Security-Policy':consolePolicy},head);
  if ((request.headers.has('Origin') && request.headers.get('Origin')!==url.origin) || request.headers.get('Sec-Fetch-Site')==='cross-site') return json({error:'forbidden'},403,head);
  if (!await authorized(request,env)) return json({error:'unauthorized'},401,head);
  if (!env.DB) return json({error:'storage_unavailable'},503,head);
  try {
    if (url.pathname==='/_nightjar/api/overview') return json(await overview(env),200,head);
    if (url.pathname==='/_nightjar/api/events') return json(await readEvents(env,{limit:Math.max(1,Math.min(100,Number(url.searchParams.get('limit'))||50)),before:url.searchParams.get('before')||undefined}),200,head);
    return json({error:'not_found'},404,head);
  } catch { return json({error:'storage_unavailable'},503,head); }
}

export async function handleRequest(request,env={},ctx={}) {
  discardBody(request); // Never read or persist submitted credentials or files.
  let url;
  try { url=new URL(request.url); } catch { return reply('Bad request\n',400,'text/plain; charset=utf-8'); }
  if (url.pathname==='/_nightjar' || url.pathname.startsWith('/_nightjar/')) return privateRoute(request,env,url);
  const head=request.method==='HEAD';
  let response,category='discovery';
  const recordPath=url.pathname;
  if (request.url.length>4096) response=reply('URI too long\n',414,'text/plain; charset=utf-8',{},head);
  else if (request.method==='CONNECT') response=reply('Method not allowed\n',405,'text/plain; charset=utf-8',{},head);
  else if (url.pathname==='/upload' || url.pathname==='/api/upload') {
    category='artifact';
    response=json({error:'intake_unavailable',message:'Artifact intake is unavailable on this deployment.'},503,head);
  } else if (Number(request.headers.get('Content-Length')||0)>8192) response=reply('Request too large\n',413,'text/plain; charset=utf-8',{},head);
  else {
    let malformed=false;
    try { malformed=/[\u0000-\u001f\u007f]/.test(decodeURIComponent(url.pathname)); } catch { malformed=true; }
    if (malformed) response=reply('Bad request\n',400,'text/plain; charset=utf-8',{},head);
    else {
      const target=url.pathname+url.search;
      const matches=compiled.filter(item=>item.matcher.test(target));
      const route=matches.find(item=>!item.methods || item.methods.includes(request.method));
      category=route?.category ?? matches[0]?.category ?? 'discovery';
      if (route) response=reply(route.body,route.status,route.type,route.headers,head);
      else if (matches.length) response=reply('Method not allowed\n',405,'text/plain; charset=utf-8',{'Allow':[...new Set(matches.flatMap(item=>item.methods??[]))].join(', ')},head);
      else response=reply(notFound,404,undefined,{},head);
    }
  }
  // A hosted dispatcher may supply its own peer address. Disable IP attribution
  // there unless the deployment explicitly enables trusted edge attribution.
  let observed=request;
  if (env.TRUST_CF_IP!=='1') {
    const headers=new Headers(request.headers);
    headers.delete('CF-Connecting-IP');
    headers.delete('CF-IPCountry');
    observed={url:request.url,method:request.method,headers,cf:request.cf};
  }
  const write=recordEvent(env,observed,{category,status:response.status,path:recordPath}).then(()=>pruneEvents(env)).catch(()=>false);
  if (typeof ctx.waitUntil==='function') ctx.waitUntil(write); else await write;
  return response;
}

export default {
  fetch:handleRequest,
  async scheduled(controller,env,ctx) {
    const cleanup=pruneEvents(env,controller?.scheduledTime ?? Date.now()).catch(()=>{});
    if (typeof ctx?.waitUntil==='function') ctx.waitUntil(cleanup); else await cleanup;
  },
};
