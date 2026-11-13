import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dashboardHtml, dashboardScript, mountDashboard } from '../src/ui.mjs';

class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.listeners=new Map();this.value='';this.disabled=false;this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(item=>typeof item==='string'?item:item.textContent).join('');}
  set innerHTML(_){throw new Error('Metadata cannot use HTML rendering');}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this._text='';this.children=items;}
  addEventListener(event,handler){const handlers=this.listeners.get(event)??[];handlers.push(handler);this.listeners.set(event,handlers);}
  removeEventListener(event,handler){this.listeners.set(event,(this.listeners.get(event)??[]).filter(item=>item!==handler));}
  async trigger(event){for(const handler of this.listeners.get(event)??[])await handler({preventDefault(){}});}
  click(){this.clicked=true;}
  remove(){this.removed=true;}
}
const summary={available:true,total_events:14,daily_events:14,daily_limit:5000,retained_limit:20000,retention_days:7,first_event_ms:Date.parse('2026-11-13T10:00:00Z'),last_event_ms:Date.parse('2026-11-13T11:59:00Z')};
const event={id:'record-one',timestamp_ms:summary.last_event_ms,method:'GET',path:'/admin/',category:'authentication',status:200,user_agent:'curl/8',source_hash:null,country:null};
const response=(data,status=200)=>({ok:status>=200&&status<300,status,async json(){return data;}});
function harness(fetch){
  const elements=new Map([...dashboardHtml.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element()]));
  const created=[],timers=new Set(),exports=[];
  const document={getElementById:id=>elements.get(id),body:new Element('body'),createElement(tag){const item=new Element(tag);created.push(item);return item;}};
  const window=new Element('window');
  const controller=mountDashboard({document,window,fetch,now:()=>Date.parse('2026-11-13T12:00:00Z'),setTimeout(callback){const timer={callback};timers.add(timer);return timer;},clearTimeout(timer){timers.delete(timer);},URL:{createObjectURL(blob){exports.push(blob);return 'blob:private-test';},revokeObjectURL(){}}});
  return {get:id=>elements.get(id),elements,created,timers,exports,window,controller};
}

test('initial load uses only same-origin APIs and leaves no polling timers',async()=>{
  const calls=[];
  const h=harness(async(path,options)=>{calls.push({path,options});return response(path==='/api/overview'?summary:{events:[event],next_before:null});});
  await h.controller.ready;
  assert.equal(calls.length,2);
  for(const {path,options}of calls){assert.ok(path.startsWith('/api/'));assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.deepEqual(options.headers,{Accept:'application/json'});}
  assert.equal(h.get('stored').textContent,'14');
  assert.equal(h.get('daily').textContent,'14');
  assert.match(h.get('daily-cap').textContent,/5,000/);
  assert.match(h.get('status').textContent,/manual refresh/);
  assert.equal(h.timers.size,0);
  h.controller.destroy();
});

test('metadata is rendered as bounded text and excess rows are excluded',async()=>{
  const payload='<img src=x onerror=alert(1)>';
  const h=harness(async path=>response(path==='/api/overview'?summary:{events:Array.from({length:90},(_,id)=>({...event,id,path:payload,user_agent:payload+'x'.repeat(500)})),next_before:null}));
  await h.controller.ready;
  assert.equal(h.get('events').children.length,50);
  assert.ok(h.get('events').textContent.includes(payload));
  assert.ok(h.created.every(item=>!['img','script'].includes(item.tagName)));
  for(const row of h.get('events').children){assert.equal(row.children.length,6);assert.ok(row.children[5].textContent.length<=256);}
  assert.ok(!dashboardHtml.includes('source hash'));
  h.controller.destroy();
});

test('current-page filters and timezone changes require no API queries',async()=>{
  let count=0;
  const h=harness(async path=>{count++;return response(path==='/api/overview'?summary:{events:[event,{...event,id:'two',path:'/robots.txt',category:'discovery',user_agent:'browser'}],next_before:null});});
  await h.controller.ready;
  assert.match(h.get('last-seen').textContent,/EST/);
  h.get('search').value='curl';await h.get('search').trigger('input');
  assert.equal(h.get('events').children.length,1);
  assert.ok(h.get('events').textContent.includes('/admin/'));
  h.get('category').value='discovery';await h.get('category').trigger('change');
  assert.match(h.get('events').textContent,/No requests match/);
  await h.get('clear-filters').trigger('click');assert.equal(h.get('events').children.length,2);
  h.get('timezone').value='UTC';await h.get('timezone').trigger('change');
  assert.match(h.get('last-seen').textContent,/UTC/);
  assert.match(h.get('zone-label').textContent,/times in UTC/);
  assert.equal(count,2);
  h.controller.destroy();
});

test('older page passes an opaque cursor using one query and newest refreshes the overview',async()=>{
  const calls=[],cursor='timestamp:id+with/slash=?';
  const h=harness(async path=>{calls.push(path);return response(path==='/api/overview'?summary:{events:[event],next_before:cursor});});
  await h.controller.ready;
  assert.equal(h.get('newest').disabled,true);
  await h.get('older').trigger('click');assert.equal(calls.length,3);
  assert.equal(new URL(calls[2],'https://example.invalid').searchParams.get('before'),cursor);
  assert.match(h.get('page-note').textContent,/page 2/);
  await h.get('newest').trigger('click');assert.equal(calls.length,5);
  assert.ok(!calls[3].includes('before='));assert.match(h.get('page-note').textContent,/page 1/);
  h.controller.destroy();
});

test('network errors retain a clearly stale snapshot; expired private access clears it',async()=>{
  let mode='ok';
  const h=harness(async path=>{if(mode==='network')throw new TypeError('offline');if(mode==='expired')return response({},403);return response(path==='/api/overview'?summary:{events:[event],next_before:null});});
  await h.controller.ready;
  mode='network';await h.get('refresh').trigger('click');
  assert.equal(h.get('stored').textContent,'14');assert.match(h.get('status').textContent,/previous snapshot retained/);
  mode='expired';await h.get('refresh').trigger('click');
  assert.equal(h.get('stored').textContent,'—');assert.ok(!h.get('events').textContent.includes('/admin/'));
  assert.match(h.get('message').textContent,/Private access has expired/);
  h.controller.destroy();
});

test('page departure aborts pending reads and stale responses cannot restore private data',async()=>{
  let pendingMode=false;const pending=[];
  const h=harness((path,options)=>pendingMode?new Promise(resolve=>pending.push({path,options,resolve})):Promise.resolve(response(path==='/api/overview'?summary:{events:[event],next_before:null})));
  await h.controller.ready;pendingMode=true;
  const refreshing=h.get('refresh').trigger('click');assert.equal(pending.length,2);
  await h.window.trigger('pagehide');assert.ok(pending.every(item=>item.options.signal.aborted));
  for(const item of pending)item.resolve(response(item.path==='/api/overview'?summary:{events:[event],next_before:'older'}));
  await refreshing;
  assert.equal(h.get('stored').textContent,'—');assert.ok(!h.get('events').textContent.includes('/admin/'));
  assert.equal(h.get('older').disabled,true);
  h.controller.destroy();
});

test('visible JSON export contains only selected bounded request metadata',async()=>{
  const h=harness(async path=>response(path==='/api/overview'?summary:{events:[{...event,source_hash:'not-for-export',country:'XX',unselected:'extra'},{...event,id:'two',path:'/robots.txt',user_agent:'browser'}],next_before:null}));
  await h.controller.ready;h.get('search').value='/admin';await h.get('search').trigger('input');
  await h.get('download').trigger('click');assert.equal(h.exports.length,1);
  const exported=JSON.parse(await h.exports[0].text());
  assert.equal(exported.events.length,1);assert.equal(exported.events[0].path,'/admin/');
  assert.deepEqual(Object.keys(exported.events[0]),['id','timestamp_ms','method','path','category','status','user_agent']);
  assert.ok(h.created.some(item=>item.tagName==='a'&&item.clicked&&item.removed));
  h.controller.destroy();
});

test('browser bundle parses and contains no credential prompt, persistent storage or background polling',()=>{
  assert.doesNotThrow(()=>new vm.Script(dashboardScript));
  assert.match(dashboardHtml,/<script defer src="\/app\.js"><\/script>/);
  assert.ok(!/localStorage|sessionStorage|Authorization|ADMIN_TOKEN|setInterval/.test(dashboardScript));
  assert.ok(!/type="password"|<form/.test(dashboardHtml));
  assert.ok(dashboardHtml.includes('requests, not a count of attackers'));
});
