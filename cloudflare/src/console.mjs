/** Public viewer shell; observations are available only through authenticated APIs. */
export const consoleHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="referrer" content="no-referrer"><title>guike8 / observations</title>
<style>
:root{color-scheme:dark;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:#120c0f;color:#ebdfe2}*{box-sizing:border-box}body{margin:0;padding:2rem}main{max-width:1150px;margin:1rem auto}header{display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid #48222b;padding-bottom:1.5rem}.vampire{color:#e47676;font-size:1.3rem;white-space:nowrap}h1{font-size:clamp(1.6rem,5vw,2.4rem);font-weight:500;letter-spacing:-.06em;line-height:1.2;margin:0;color:#df5555}h1 span{color:#b88995;font-size:.7em}h2{font-size:.9rem;font-weight:400;color:#b88995;margin:0 0 1rem}p{color:#b88995}.intro{margin:1.4rem 0 1.8rem;max-width:70ch}button,input{font:inherit;border-radius:2px}button{background:#37171f;color:#f6c0c5;border:1px solid #793542;padding:.55rem .9rem;cursor:pointer}button:hover:not(:disabled){background:#52212c}button:disabled{opacity:.4;cursor:default}input{background:#1b1015;color:#ebdfe2;border:1px solid #793542;padding:.65rem .8rem;min-width:0;width:min(100%,30rem)}button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid #e47676;outline-offset:4px}.auth{padding:1.2rem;border:1px solid #48222b;background:#1b1015}.auth label{display:block;margin-bottom:.7rem;color:#c99da8}.auth-row{display:flex;gap:.6rem}.auth small{display:block;color:#b88995;margin-top:.7rem}#feedback{min-height:1.6em;color:#e69b8d;margin:1rem 0}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:1.2rem 0}.toolbar-actions{display:flex;gap:.5rem}#status{color:#b88995;font-size:.85rem}.metrics{display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:1rem;margin:1.4rem 0 1.8rem}.metric{padding:1.1rem;border:1px solid #48222b;background:#1b1015}.metric-label{color:#b88995;font-size:.8rem}.metric-value{font-size:1.8rem;line-height:1.4;color:#e47676;margin:.3rem 0;overflow-wrap:anywhere}.metric:last-child .metric-value{font-size:.95rem;margin:.8rem 0}.metric small{color:#a17280;font-size:.75rem}.table-wrap{max-width:100%;overflow-x:auto;border:1px solid #48222b}table{width:100%;border-collapse:collapse;text-align:left;min-width:1020px}th{font-weight:400;color:#c99da8;background:#23131a;font-size:.75rem;white-space:nowrap}td,th{padding:.8rem .9rem;border-bottom:1px solid #38202a;vertical-align:top}td{font-size:.75rem}tbody tr:last-child td{border-bottom:0}td.path{max-width:270px;overflow-wrap:anywhere;color:#f0b1b8}td.agent{max-width:250px;overflow-wrap:anywhere;color:#b88995}td.time{white-space:nowrap;color:#b88995}td.source{color:#b88995;white-space:nowrap}.empty{text-align:center;padding:2.3rem;color:#a17280}.pagination{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:1rem 0}.pagination p{margin:0;font-size:.75rem}.note,footer{font-size:.75rem;color:#a17280;max-width:100ch}footer{border-top:1px solid #48222b;padding-top:1rem;margin-top:2rem;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}a{color:#e47676;text-underline-offset:.3em}[hidden]{display:none!important}@media(max-width:650px){body{padding:1.25rem}.metrics{grid-template-columns:1fr 1fr;gap:.6rem}.metric{padding:.9rem}.metric:last-child{grid-column:1/-1}.auth-row{flex-wrap:wrap}.auth-row input{width:100%}.metric-value{font-size:1.5rem}.vampire{font-size:1rem}.pagination{align-items:flex-start;flex-wrap:wrap}}
</style><script defer src="/_nightjar/app.js"></script></head><body><main>
<header><h1>guike8 <span>/ observations</span></h1><span class="vampire" role="img" aria-label="vampire kaomoji">㇏(•̀ᵥᵥ•́)ノ</span></header>
<p class="intro">HTTP requests recorded by the honeypot. Refresh manually to read new observations; this page does not poll in the background.</p>
<section id="auth-panel" class="auth"><form id="auth-form" method="post" action="/_nightjar" autocomplete="off"><label for="token">Private viewer token</label><div class="auth-row"><input id="token" type="password" autocomplete="off" spellcheck="false" required placeholder="Enter the server token"><button id="unlock" type="submit">unlock ↗</button></div><small>The token stays in this tab’s memory. It is sent only in the API authorization header.</small></form></section>
<p id="feedback" role="status" aria-live="polite"></p>
<div class="toolbar"><span id="status">locked / no observations loaded</span><div class="toolbar-actions"><button id="refresh" type="button" disabled>refresh</button><button id="logout" type="button" hidden>lock</button></div></div>
<section class="metrics" aria-label="Recorded activity"><div class="metric"><div class="metric-label">stored events</div><div id="stored" class="metric-value">—</div><small id="retained-limit">retention cap not loaded</small></div><div class="metric"><div class="metric-label">recorded today / UTC</div><div id="daily" class="metric-value">—</div><small id="daily-limit">daily logging cap not loaded</small></div><div class="metric"><div class="metric-label">last observation / UTC</div><div id="last-seen" class="metric-value">—</div><small id="retention">retention window not loaded</small></div></section>
<h2>recent requests</h2><div class="table-wrap" role="region" aria-label="Request observations" tabindex="0"><table><thead><tr><th scope="col">time / UTC</th><th scope="col">method</th><th scope="col">path</th><th scope="col">category</th><th scope="col">status</th><th scope="col">daily source hash</th><th scope="col">country¹</th><th scope="col">user agent</th></tr></thead><tbody id="events"><tr><td colspan="8" class="empty">Unlock the viewer to load recorded requests.</td></tr></tbody></table></div>
<div class="pagination"><p id="page-note">No request data is embedded in this page.</p><button id="older" type="button" disabled>older observations ↓</button></div>
<p class="note">Source hashes rotate daily; they are not identities or a count of people. ¹ Country is an edge-provided estimate. Requests may come from scanners, previews, or curious visitors. A recorded request is not proof of malicious intent. Ingress blocks, sampling, and logging caps can leave gaps.</p>
<footer><a href="/">← homepage</a><span>metadata only / (•̀ᵥᵥ•́)</span></footer>
</main></body></html>`;

/** Dependency-free browser controller, also exercised with a small DOM in unit tests. */
export function mountConsole(environment = {}) {
  const doc = environment.document ?? globalThis.document;
  const request = environment.fetch ?? globalThis.fetch.bind(globalThis);
  const Controller = environment.AbortController ?? globalThis.AbortController;
  const setTimer = environment.setTimeout ?? globalThis.setTimeout;
  const clearTimer = environment.clearTimeout ?? globalThis.clearTimeout;
  const clock = environment.now ?? Date.now;
  const ids = ['auth-panel','auth-form','token','unlock','feedback','status','refresh','logout','stored','retained-limit','daily','daily-limit','last-seen','retention','events','page-note','older'];
  const ui = Object.fromEntries(ids.map(id => [id, doc.getElementById(id)]));
  const formatter = new Intl.NumberFormat('en-US');
  let token = '';
  let cursor = null;
  let generation = 0;
  let active = null;
  let destroyed = false;
  let hasSnapshot = false;
  let quotaMessage = '';
  const bounded = (value, limit = 256) => value == null ? '—' : String(value).slice(0, limit);
  const numeric = value => Number.isSafeInteger(value) && value >= 0 ? formatter.format(value) : '—';
  const date = value => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '—';
  const element = (tag, content, className) => {
    const result = doc.createElement(tag);
    if (content !== undefined) result.textContent = bounded(content, 1024);
    if (className) result.className = className;
    return result;
  };
  function empty(message) {
    const row = element('tr');
    const cell = element('td', message, 'empty');
    cell.colSpan = 8;
    row.append(cell);
    ui.events.replaceChildren(row);
  }
  function controls(busy = false) {
    ui.refresh.disabled = !token || busy;
    ui.older.disabled = !token || busy || !cursor;
    ui.unlock.disabled = busy;
    ui.logout.hidden = !token;
  }
  function reset(message = '') {
    generation += 1;
    active?.abort();
    active = null;
    token = '';
    cursor = null;
    hasSnapshot = false;
    quotaMessage = '';
    ui.token.value = '';
    ui['auth-panel'].hidden = false;
    ui.feedback.textContent = message;
    ui.status.textContent = 'locked / no observations loaded';
    for (const id of ['stored','daily','last-seen']) ui[id].textContent = '—';
    ui['retained-limit'].textContent = 'retention cap not loaded';
    ui['daily-limit'].textContent = 'daily logging cap not loaded';
    ui.retention.textContent = 'retention window not loaded';
    ui['page-note'].textContent = 'No request data is embedded in this page.';
    empty('Unlock the viewer to load recorded requests.');
    controls();
  }
  async function read(path, signal, credential) {
    const response = await request(path, {
      method:'GET', headers:{Authorization:`Bearer ${credential}`,Accept:'application/json'},
      credentials:'omit', cache:'no-store', redirect:'error', signal,
    });
    if (!response.ok) {
      const error = new Error('API request failed');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  function renderOverview(data) {
    if (!data || data.available === false) throw new Error('Storage is unavailable');
    ui.stored.textContent = numeric(data.total_events);
    ui.daily.textContent = numeric(data.daily_events);
    ui['retained-limit'].textContent = `${numeric(data.retained_limit)} stored-event cap`;
    ui['daily-limit'].textContent = `${numeric(data.daily_limit)} daily logging cap`;
    ui['last-seen'].textContent = date(data.last_event_ms);
    ui.retention.textContent = `${numeric(data.retention_days)}-day retention window`;
    return Number.isSafeInteger(data.daily_events) && Number.isSafeInteger(data.daily_limit) && data.daily_events >= data.daily_limit
      ? 'The daily logging cap has been reached. The decoy may still respond while new observations are omitted.' : '';
  }
  function renderEvents(data) {
    if (!data || !Array.isArray(data.events)) throw new Error('Unexpected event response');
    const events = data.events.slice(0, 50);
    cursor = typeof data.next_before === 'string' && data.next_before.length > 0 && data.next_before.length <= 1024 ? data.next_before : null;
    if (!events.length) empty('No recorded requests in this page of the retained window.');
    else ui.events.replaceChildren(...events.map(event => {
      const row = element('tr');
      const source = bounded(event.source_hash, 128);
      const sourceCell = element('td', source === '—' ? source : source.slice(0, 12), 'source');
      sourceCell.title = source;
      const country = /^[A-Z]{2}$/.test(event.country) ? event.country : '—';
      const agent = element('td', bounded(event.user_agent, 256), 'agent');
      agent.title = bounded(event.user_agent, 256);
      row.append(element('td', date(event.timestamp_ms), 'time'),element('td', bounded(event.method, 16)),element('td', bounded(event.path, 256), 'path'),element('td', bounded(event.category, 40)),element('td', bounded(event.status, 3)),sourceCell,element('td', country),agent);
      return row;
    }));
    ui['page-note'].textContent = `${events.length} recorded requests shown · newest first within this page`;
  }
  async function load(older = false) {
    if (!token || destroyed || (older && !cursor)) return;
    active?.abort();
    const current = ++generation;
    const credential = token;
    const controller = new Controller();
    active = controller;
    let timedOut = false;
    const timer = setTimer(() => { timedOut = true; controller.abort(); }, 10000);
    timer?.unref?.();
    controls(true);
    ui.feedback.textContent = '';
    ui.status.textContent = 'reading stored observations…';
    const query = new URLSearchParams({limit:'50'});
    if (older) query.set('before', cursor);
    try {
      const [events, overview] = await Promise.all([
        read(`/_nightjar/api/events?${query}`, controller.signal, credential),
        older ? Promise.resolve(null) : read('/_nightjar/api/overview', controller.signal, credential),
      ]);
      if (current !== generation || credential !== token || destroyed) return;
      if (!events || !Array.isArray(events.events)) throw new Error('Unexpected event response');
      if (overview) quotaMessage = renderOverview(overview);
      renderEvents(events);
      hasSnapshot = true;
      ui['auth-panel'].hidden = true;
      ui.status.textContent = `snapshot read ${date(clock())} / manual refresh`;
      ui.feedback.textContent = quotaMessage;
    } catch (error) {
      if (current !== generation || credential !== token || destroyed || (error.name === 'AbortError' && !timedOut)) return;
      if (error.status === 401 || error.status === 403) {
        reset('Token not accepted. Enter the current private viewer token.');
        return;
      }
      ui.status.textContent = hasSnapshot ? 'read failed / previous snapshot retained' : 'read failed / no observations loaded';
      ui.feedback.textContent = timedOut ? 'The request timed out. Refresh to try again.' : 'Could not read stored observations. Check the service and refresh to try again.';
    } finally {
      clearTimer(timer);
      controller.abort();
      if (current === generation && credential === token && !destroyed) { active = null; controls(); }
    }
  }
  const onSubmit = event => {
    event.preventDefault();
    const credential = ui.token.value.trim();
    if (!credential) return;
    token = credential;
    ui.token.value = '';
    cursor = null;
    return load(false);
  };
  const onRefresh = () => load(false);
  const onOlder = () => load(true);
  const onLogout = () => reset();
  const onPageHide = () => reset();
  ui['auth-form'].addEventListener('submit', onSubmit);
  ui.refresh.addEventListener('click', onRefresh);
  ui.older.addEventListener('click', onOlder);
  ui.logout.addEventListener('click', onLogout);
  const windowTarget = environment.window ?? globalThis.window;
  windowTarget?.addEventListener('pagehide', onPageHide);
  reset();
  return {
    destroy() {
      destroyed = true;
      reset();
      ui['auth-form'].removeEventListener('submit', onSubmit);
      ui.refresh.removeEventListener('click', onRefresh);
      ui.older.removeEventListener('click', onOlder);
      ui.logout.removeEventListener('click', onLogout);
      windowTarget?.removeEventListener('pagehide', onPageHide);
    },
  };
}

export const consoleScript = `(${mountConsole.toString()})();\n`;
