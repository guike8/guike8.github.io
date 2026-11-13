/** Owner-private dashboard shell. The server proxy supplies upstream access. */
export const dashboardHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="referrer" content="no-referrer"><title>guike8 / request log</title><style>
:root{color-scheme:dark;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:#120c0f;color:#ebdfe2;--muted:#b88995;--red:#e47676;--border:#48222b}*{box-sizing:border-box}body{margin:0;padding:2rem}main{max-width:1140px;margin:1rem auto}header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-bottom:1.5rem;border-bottom:1px solid var(--border)}h1{font-size:clamp(1.5rem,5vw,2.3rem);font-weight:500;letter-spacing:-.06em;line-height:1.2;margin:0;color:#df5555}h1 span{font-size:.7em;color:var(--muted)}.vampire{font-size:1.35rem;color:var(--red);white-space:nowrap}.intro{max-width:76ch;margin:1.35rem 0 1.6rem;color:var(--muted);font-size:.85rem}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}.toolbar-actions{display:flex;gap:.5rem;align-items:center}button,input,select{font:inherit;border:1px solid #793542;border-radius:2px}button{padding:.5rem .8rem;color:#f6c0c5;background:#37171f;cursor:pointer}button:hover:not(:disabled){background:#52212c}button:disabled{opacity:.4;cursor:default}input,select{padding:.55rem .65rem;background:#1b1015;color:#ebdfe2;min-width:0}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--red);outline-offset:4px}label{color:var(--muted);font-size:.75rem}#status{font-size:.8rem;color:var(--muted)}#message{min-height:1.6em;color:#e8aa8a;font-size:.8rem;margin:.8rem 0}.metrics{display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:1rem;margin:1.2rem 0 1.7rem}.metric{background:#1b1015;border:1px solid var(--border);padding:1.1rem}.metric-label{color:var(--muted);font-size:.8rem}.metric-value{color:var(--red);font-size:1.8rem;margin:.35rem 0;line-height:1.35;overflow-wrap:anywhere}.metric:last-child .metric-value{font-size:.95rem;margin:.85rem 0}.metric small{font-size:.75rem;color:#a17280}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:0 0 .8rem}h2{color:#c99da8;font-weight:400;font-size:1rem;margin:0}.filter-note{color:#a17280;font-size:.75rem}.filters{display:flex;align-items:end;gap:.65rem;flex-wrap:wrap;margin-bottom:1rem}.filter{display:grid;gap:.35rem}.filter.search{flex:1;min-width:220px}.filter.search input{width:100%}.filters select{min-width:160px}.table-wrap{max-width:100%;overflow-x:auto;border:1px solid var(--border)}table{width:100%;min-width:900px;border-collapse:collapse;text-align:left}th{background:#23131a;color:#c99da8;font-size:.75rem;font-weight:400;white-space:nowrap}td,th{padding:.8rem .9rem;border-bottom:1px solid #38202a;vertical-align:top}td{font-size:.75rem}tbody tr:last-child td{border-bottom:0}td.time{white-space:nowrap;color:var(--muted)}td.path{max-width:340px;overflow-wrap:anywhere;color:#f0b1b8}td.agent{max-width:240px;overflow-wrap:anywhere;color:var(--muted)}td.category{color:var(--muted)}.empty{text-align:center;padding:2.3rem;color:#a17280}.pagination{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:1rem 0}.pagination-buttons{display:flex;gap:.5rem}#page-note{margin:0;color:var(--muted);font-size:.75rem}.note,footer{color:#a17280;font-size:.75rem}.note{max-width:100ch;margin-top:1.5rem}footer{border-top:1px solid var(--border);margin-top:2rem;padding-top:1rem;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}a{color:var(--red);text-underline-offset:.3em}@media(max-width:650px){body{padding:1.25rem}.metrics{grid-template-columns:1fr 1fr;gap:.6rem}.metric{padding:.9rem}.metric:last-child{grid-column:1/-1}.metric-value{font-size:1.5rem}.vampire{font-size:1rem}.toolbar-actions{flex-wrap:wrap}.filter.search{min-width:100%}.filters .filter:not(.search){flex:1}.filters select{width:100%;min-width:0}.filters button{font-size:.8rem}}[hidden]{display:none!important}
</style><script defer src="/app.js"></script></head><body><main>
<header><h1>guike8 <span>/ request log</span></h1><span class="vampire" role="img" aria-label="vampire kaomoji">㇏(•̀ᵥᵥ•́)ノ</span></header>
<p class="intro">Your honeypot’s recorded HTTP requests, in one private view. Refresh when you want an update; nothing polls in the background.</p>
<div class="toolbar"><span id="status" role="status">loading recorded requests…</span><div class="toolbar-actions"><label for="timezone">time zone</label><select id="timezone"><option value="America/New_York">America/New_York</option><option value="UTC">UTC</option></select><button id="refresh" type="button">refresh ↻</button></div></div>
<p id="message" role="status" aria-live="polite"></p>
<section class="metrics" aria-label="Recorded activity"><div class="metric"><div class="metric-label">stored requests</div><div id="stored" class="metric-value">—</div><small id="stored-cap">retention cap not loaded</small></div><div class="metric"><div class="metric-label">recorded today / UTC</div><div id="daily" class="metric-value">—</div><small id="daily-cap">daily logging cap not loaded</small></div><div class="metric"><div class="metric-label">last recorded request</div><div id="last-seen" class="metric-value">—</div><small id="retention">retention window not loaded</small></div></section>
<div class="section-heading"><h2>recent requests</h2><span class="filter-note">filters apply to this page only</span></div>
<div class="filters"><label class="filter search" for="search">path or client<input id="search" type="search" maxlength="200" placeholder="e.g. /admin or curl" autocomplete="off"></label><label class="filter" for="category">category<select id="category"><option value="">all categories</option></select></label><button id="clear-filters" type="button">clear filters</button><button id="download" type="button" disabled>export visible JSON ↓</button></div>
<div class="table-wrap" role="region" aria-label="Recorded request table" tabindex="0"><table><thead><tr><th scope="col">time</th><th scope="col">method</th><th scope="col">path</th><th scope="col">category</th><th scope="col">status</th><th scope="col">client</th></tr></thead><tbody id="events"><tr><td colspan="6" class="empty">Loading recorded requests…</td></tr></tbody></table></div>
<div class="pagination"><p id="page-note">Up to 50 requests per page.</p><div class="pagination-buttons"><button id="newest" type="button" disabled>↑ newest</button><button id="older" type="button" disabled>older ↓</button></div></div>
<p class="note">These are requests, not a count of attackers. Verification checks, browser visits, previews, and crawlers can all appear here. Client labels describe the request’s user agent and can be imitated. Logs contain bounded metadata; bodies, submitted credentials, and uploaded files are discarded. Logging caps and edge filtering can leave gaps.</p>
<footer><span>private observations / (•̀ᵥᵥ•́)</span><span id="zone-label">times in America/New_York</span></footer>
</main></body></html>`;

/** No listeners or servers: dependency injection permits pure controller tests. */
export function mountDashboard(environment = {}) {
  const doc = environment.document ?? globalThis.document;
  const request = environment.fetch ?? globalThis.fetch.bind(globalThis);
  const Controller = environment.AbortController ?? globalThis.AbortController;
  const setTimer = environment.setTimeout ?? globalThis.setTimeout;
  const clearTimer = environment.clearTimeout ?? globalThis.clearTimeout;
  const now = environment.now ?? Date.now;
  const ids = ['status','timezone','refresh','message','stored','stored-cap','daily','daily-cap','last-seen','retention','search','category','clear-filters','download','events','page-note','newest','older','zone-label'];
  const ui = Object.fromEntries(ids.map(id => [id, doc.getElementById(id)]));
  const numeric = value => Number.isSafeInteger(value) && value >= 0 ? new Intl.NumberFormat('en-US').format(value) : '—';
  const bounded = (value, length = 256) => value == null || value === '' ? '—' : String(value).slice(0, length);
  let rows = [], summary = null, cursor = null, generation = 0, active = null;
  let page = 1, snapshotAt = null, lastError = false, busy = false, destroyed = false;
  let zone = 'America/New_York';
  function formatTime(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', {timeZone:zone,month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'short'}).format(value);
  }
  function element(tag, content, className) {
    const result = doc.createElement(tag);
    if (content !== undefined) result.textContent = bounded(content, 1024);
    if (className) result.className = className;
    return result;
  }
  function empty(message) {
    const row = element('tr'), cell = element('td', message, 'empty');
    cell.colSpan = 6; row.append(cell); ui.events.replaceChildren(row);
  }
  function controls() {
    ui.refresh.disabled = busy || destroyed;
    ui.newest.disabled = busy || destroyed || page === 1;
    ui.older.disabled = busy || destroyed || !cursor;
    ui.download.disabled = busy || destroyed || !visibleRows().length;
  }
  function visibleRows() {
    const term = ui.search.value.trim().toLowerCase();
    return rows.filter(row => (!ui.category.value || row.category === ui.category.value) && (!term || `${row.path} ${row.user_agent}`.toLowerCase().includes(term)));
  }
  function renderSummary() {
    ui.stored.textContent = summary ? numeric(summary.total_events) : '—';
    ui.daily.textContent = summary ? numeric(summary.daily_events) : '—';
    ui['stored-cap'].textContent = summary ? `${numeric(summary.retained_limit)} stored-request cap` : 'retention cap not loaded';
    ui['daily-cap'].textContent = summary ? `${numeric(summary.daily_limit)} daily logging cap` : 'daily logging cap not loaded';
    ui['last-seen'].textContent = summary ? formatTime(summary.last_event_ms) : '—';
    ui.retention.textContent = summary ? `${numeric(summary.retention_days)}-day retention window` : 'retention window not loaded';
    ui['zone-label'].textContent = `times in ${zone} / daily counter uses UTC`;
  }
  function quotaNotice() {
    return summary && Number.isSafeInteger(summary.daily_events) && Number.isSafeInteger(summary.daily_limit) && summary.daily_events >= summary.daily_limit
      ? 'Daily logging cap reached. The decoy can still respond while new requests are omitted from the log.' : '';
  }
  function renderStatus() {
    if (busy) ui.status.textContent = 'reading recorded requests…';
    else if (lastError) ui.status.textContent = snapshotAt ? 'read failed / previous snapshot retained' : 'read failed / no requests loaded';
    else if (snapshotAt) ui.status.textContent = `updated ${formatTime(snapshotAt)} / manual refresh`;
    else ui.status.textContent = 'refresh to load recorded requests';
  }
  function renderRows() {
    const visible = visibleRows();
    if (!visible.length) empty(rows.length ? 'No requests match these filters on this page.' : 'No recorded requests in this page of the retained window.');
    else ui.events.replaceChildren(...visible.map(row => {
      const result = element('tr');
      const path = element('td', row.path, 'path'); path.title = row.path;
      const agent = element('td', row.user_agent, 'agent'); agent.title = row.user_agent;
      result.append(element('td',formatTime(row.timestamp_ms),'time'),element('td',row.method),path,element('td',row.category,'category'),element('td',row.status),agent);
      return result;
    }));
    ui['page-note'].textContent = `${visible.length} of ${rows.length} requests shown / page ${page} / newest first`;
    controls();
  }
  function normalizeRows(value) {
    if (!value || !Array.isArray(value.events)) throw new Error('Invalid event response');
    return value.events.slice(0,50).filter(row => row && typeof row === 'object').map(row => ({
      id:bounded(row.id,96),timestamp_ms:typeof row.timestamp_ms === 'number' ? row.timestamp_ms : null,
      method:bounded(row.method,16),path:bounded(row.path,256),category:bounded(row.category,40),
      status:Number.isInteger(row.status) ? Math.max(0,Math.min(599,row.status)) : null,user_agent:bounded(row.user_agent,256),
    }));
  }
  async function read(path, signal) {
    const response = await request(path, {method:'GET',headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store',redirect:'error',signal});
    if (!response.ok) { const error = new Error('Private API request failed'); error.status=response.status; throw error; }
    return response.json();
  }
  async function load(older = false) {
    if (destroyed || (older && !cursor)) return;
    active?.abort();
    const current = ++generation, controller = new Controller();
    active=controller; busy=true; renderStatus(); controls(); ui.message.textContent='';
    let timedOut=false;
    const timer=setTimer(() => {timedOut=true;controller.abort();},10000); timer?.unref?.();
    const query=new URLSearchParams({limit:'50'}); if (older) query.set('before',cursor);
    try {
      const [data,overview] = await Promise.all([read(`/api/events?${query}`,controller.signal),older?Promise.resolve(null):read('/api/overview',controller.signal)]);
      if (current!==generation || destroyed) return;
      const incoming=normalizeRows(data);
      if (overview && overview.available===false) throw new Error('Storage unavailable');
      if (overview) summary=overview;
      rows=incoming;
      cursor=typeof data.next_before==='string' && data.next_before.length>0 && data.next_before.length<=1024 ? data.next_before : null;
      page=older?page+1:1; snapshotAt=now(); lastError=false;
      const selected=ui.category.value;
      const categories=[...new Set(rows.map(row=>row.category))].sort();
      if (selected && !categories.includes(selected)) categories.push(selected);
      const all=element('option','all categories');all.value='';
      ui.category.replaceChildren(all,...categories.map(value=>{const option=element('option',value);option.value=value;return option;}));
      ui.category.value=selected;
      renderSummary(); renderRows(); ui.message.textContent=quotaNotice();
    } catch(error) {
      if (current!==generation || destroyed || (error.name==='AbortError' && !timedOut)) return;
      if (error.status===401 || error.status===403) {
        clearData();lastError=true;
        ui.message.textContent='Private access has expired. Reopen this dashboard from your account.';
        empty('Private request data has been cleared.');renderStatus();controls();return;
      }
      lastError=true;
      ui.message.textContent=timedOut ? 'The request timed out. Refresh when you want to try again.' : 'Could not read the log. Your previous snapshot is kept; refresh to try again.';
      if (!snapshotAt) empty('Recorded requests are temporarily unavailable.');
    } finally {
      clearTimer(timer); controller.abort();
      if (current===generation && !destroyed) {active=null;busy=false;renderStatus();controls();}
    }
  }
  function clearData() {
    generation+=1;active?.abort();active=null;busy=false;rows=[];summary=null;cursor=null;snapshotAt=null;page=1;lastError=false;
    ui.search.value='';ui.category.replaceChildren(element('option','all categories'));ui.category.children[0].value='';ui.category.value='';
    ui.message.textContent='';renderSummary();renderRows();renderStatus();
  }
  const handlers={
    refresh:()=>load(false),newest:()=>load(false),older:()=>load(true),search:()=>renderRows(),category:()=>renderRows(),
    'clear-filters':()=>{ui.search.value='';ui.category.value='';renderRows();},
    timezone:()=>{zone=ui.timezone.value==='UTC'?'UTC':'America/New_York';renderSummary();renderRows();renderStatus();},
    download:()=>{
      const visible=visibleRows();if(!visible.length || destroyed)return;
      const blob=new (environment.Blob??globalThis.Blob)([JSON.stringify({exported_at:new Date(now()).toISOString(),page,events:visible},null,2)+'\n'],{type:'application/json'});
      const urls=environment.URL??globalThis.URL;const href=urls.createObjectURL(blob);const link=element('a');link.href=href;link.download=`guike8-requests-page-${page}.json`;
      doc.body.append(link);link.click();link.remove();const timer=setTimer(()=>urls.revokeObjectURL(href),1000);timer?.unref?.();
    },
  };
  const inputIds=new Set(['search','category','timezone']);
  for(const [id,handler] of Object.entries(handlers))ui[id].addEventListener(inputIds.has(id)?id==='search'?'input':'change':'click',handler);
  const windowTarget=environment.window??globalThis.window;
  windowTarget?.addEventListener('pagehide',clearData);
  ui.timezone.value=zone;
  const ready=load(false);
  return {ready,destroy(){destroyed=true;clearData();for(const[id,handler]of Object.entries(handlers))ui[id].removeEventListener(inputIds.has(id)?id==='search'?'input':'change':'click',handler);windowTarget?.removeEventListener('pagehide',clearData);controls();}};
}

export const dashboardScript = `(${mountDashboard.toString()})();\n`;
