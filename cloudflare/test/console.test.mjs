import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { consoleHtml, consoleScript, mountConsole } from '../src/console.mjs';

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = new Map(); this.value = ''; this.hidden = false; this.disabled = false; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set innerHTML(_) { throw new Error('HTML rendering must not be used for metadata'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(name, handler) { const handlers = this.listeners.get(name) ?? []; handlers.push(handler); this.listeners.set(name, handlers); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(candidate => candidate !== handler)); }
  async trigger(name) { for (const handler of this.listeners.get(name) ?? []) await handler({preventDefault() {}}); }
}
function harness(fetch) {
  const elements = new Map([...consoleHtml.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const created = [];
  const document = { getElementById: id => elements.get(id), createElement(tag) { const element = new Element(tag); created.push(element); return element; } };
  const timers = new Set();
  const window = new Element('window');
  const controller = mountConsole({document, fetch, window, now:() => Date.parse('2026-11-13T12:00:00Z'), setTimeout() { const handle = {}; timers.add(handle); return handle; }, clearTimeout(handle) { timers.delete(handle); }});
  return {elements, created, timers, window, controller, get: id => elements.get(id)};
}
const overview = {available:true,total_events:3,daily_events:2,daily_limit:5000,retained_limit:20000,retention_days:7,first_event_ms:Date.parse('2026-11-12T12:00:00Z'),last_event_ms:Date.parse('2026-11-13T11:59:00Z')};
const event = {id:'example',timestamp_ms:overview.last_event_ms,method:'GET',path:'/admin/',category:'authentication',status:200,source_hash:'abcdef123456abcdef123456',country:'US',user_agent:'example-client'};
const response = (data, status = 200) => ({ok:status >= 200 && status < 300,status,async json() { return data; }});
async function unlock(h, credential = 'only-in-memory-secret') { h.get('token').value = credential; await h.get('auth-form').trigger('submit'); }

// These tests execute the browser controller without creating a listener or
// running a local server/browser. Every request is an in-memory stub.
test('viewer has no initial requests; unlock uses only same-origin authorization headers and no persistent credentials', async () => {
  const calls = [];
  const h = harness(async (path, options) => { calls.push({path,options}); return response(path.includes('/overview') ? overview : {events:[event],next_before:null}); });
  assert.equal(calls.length, 0);
  await unlock(h);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.path.startsWith('/_nightjar/api/'));
    assert.ok(!call.path.includes('only-in-memory-secret'));
    assert.equal(call.options.headers.Authorization, 'Bearer only-in-memory-secret');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.redirect, 'error');
  }
  assert.equal(h.get('token').value, '');
  assert.equal(h.get('stored').textContent, '3');
  assert.equal(h.get('daily').textContent, '2');
  assert.match(h.get('daily-limit').textContent, /5,000/);
  assert.equal(h.get('auth-panel').hidden, true);
  assert.equal(h.timers.size, 0, 'request deadlines are cleared; no polling timers remain');
  assert.ok([...h.elements.values()].every(element => !element.textContent.includes('only-in-memory-secret')));
  h.controller.destroy();
});

test('visitor metadata remains text and at most fifty rows are rendered', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const h = harness(async path => response(path.includes('/overview') ? overview : {events:Array.from({length:80}, (_, id) => ({...event,id,path:payload,user_agent:payload})),next_before:null}));
  await unlock(h);
  assert.equal(h.get('events').children.length, 50);
  assert.ok(h.get('events').textContent.includes(payload));
  assert.ok(h.created.every(element => element.tagName !== 'img' && element.tagName !== 'script'));
  assert.match(h.get('events').textContent, /abcdef123456/);
  h.controller.destroy();
});

test('locking aborts in-flight requests and stale results cannot repopulate private data', async () => {
  const pending = [];
  const h = harness((path, options) => new Promise(resolve => pending.push({path,options,resolve})));
  h.get('token').value = 'private-test-token';
  const loading = h.get('auth-form').trigger('submit');
  assert.equal(pending.length, 2);
  await h.get('logout').trigger('click');
  assert.ok(pending.every(item => item.options.signal.aborted));
  for (const item of pending) item.resolve(response(item.path.includes('/overview') ? overview : {events:[event],next_before:'older'}));
  await loading;
  assert.equal(h.get('stored').textContent, '—');
  assert.ok(!h.get('events').textContent.includes('/admin/'));
  assert.equal(h.get('older').disabled, true);
  assert.equal(h.get('auth-panel').hidden, false);
  h.controller.destroy();
});

test('expired authentication clears a previously displayed snapshot', async () => {
  let rejected = false;
  const h = harness(async path => rejected ? response({},401) : response(path.includes('/overview') ? overview : {events:[event],next_before:null}));
  await unlock(h);
  assert.ok(h.get('events').textContent.includes('/admin/'));
  rejected = true;
  await h.get('refresh').trigger('click');
  assert.equal(h.get('stored').textContent, '—');
  assert.ok(!h.get('events').textContent.includes('/admin/'));
  assert.match(h.get('feedback').textContent, /Token not accepted/);
  assert.equal(h.get('refresh').disabled, true);
  h.controller.destroy();
});

test('older-page action uses one request with an encoded cursor; refresh returns to newest observations', async () => {
  const calls = [];
  const cursor = 'cursor+with/slash=and?query';
  const h = harness(async path => { calls.push(path); return response(path.includes('/overview') ? overview : {events:[event],next_before:cursor}); });
  await unlock(h);
  await h.get('older').trigger('click');
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[2], 'https://example.invalid').searchParams.get('before'), cursor);
  assert.ok(calls[2].includes('limit=50'));
  await h.get('refresh').trigger('click');
  assert.equal(calls.length, 5);
  assert.ok(!calls[3].includes('before='));
  h.controller.destroy();
});

test('read failure retains the old snapshot and labels it stale; quota cap is an explicit omission notice', async () => {
  let fail = false;
  const h = harness(async path => { if (fail) throw new TypeError('Network unavailable'); return response(path.includes('/overview') ? {...overview,daily_events:5000} : {events:[event],next_before:null}); });
  await unlock(h);
  assert.match(h.get('feedback').textContent, /daily logging cap/);
  fail = true;
  await h.get('refresh').trigger('click');
  assert.equal(h.get('stored').textContent, '3');
  assert.match(h.get('status').textContent, /previous snapshot retained/);
  assert.equal(h.timers.size, 0);
  h.controller.destroy();
});

test('exported browser script parses and the public HTML contains no embedded observations or credential storage', () => {
  assert.doesNotThrow(() => new vm.Script(consoleScript));
  assert.match(consoleHtml, /<script defer src="\/_nightjar\/app\.js"><\/script>/);
  assert.ok(!/localStorage|sessionStorage|document\.cookie|setInterval/.test(consoleScript));
  assert.ok(!consoleHtml.includes(event.source_hash));
  assert.ok(!/fetch\(/.test(consoleHtml));
  assert.ok(consoleHtml.includes('edge-provided estimate'));
});
