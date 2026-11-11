const $ = (id) => document.getElementById(id);
const ui = {
  auth: $('auth-panel'), form: $('auth-form'), token: $('token'), authError: $('auth-error'),
  lock: $('lock-button'), refresh: $('refresh-button'), pause: $('pause-button'), export: $('export-button'),
  status: $('status'), statusLabel: $('status-label'), updated: $('last-updated'), notice: $('notice'),
  category: $('category'), search: $('search'), body: $('events-body'), inspector: $('inspector'),
};
const number = new Intl.NumberFormat('en-US');
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short' });
let token = '';
let paused = false;
let protocol = 'all';
let controller = null;
let exportController = null;
let generation = 0;
let pollTimer = null;
let searchTimer = null;
let lastSuccess = null;
let knownEvents = [];
let selectedId = null;
let hasData = false;
let sensorHealth = { state: 'waiting', label: 'WAITING', message: 'Awaiting sensor events.' };

function text(value, fallback = '—') { return value == null || value === '' ? fallback : String(value); }
function count(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? number.format(n) : '0'; }
function validDate(value) { const d = new Date(value); return Number.isFinite(d.getTime()) ? d : null; }
function clock(value) { const d = validDate(value); return d ? timeFormat.format(d) : '—'; }
function day(value) { const d = validDate(value); return d ? dayFormat.format(d) : '—'; }
function make(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content !== undefined) el.textContent = text(content, '');
  return el;
}
function setStatus(state, label) {
  ui.status.className = `status ${state}`;
  ui.statusLabel.textContent = label;
}
function notice(message = '') {
  ui.notice.textContent = message;
  ui.notice.classList.toggle('hidden', !message);
}
function setControls(enabled) {
  for (const button of [ui.refresh, ui.pause]) button.disabled = !enabled;
  ui.export.disabled = !enabled || Boolean(exportController);
  ui.lock.classList.toggle('hidden', !enabled);
}
function resetData() {
  for (const id of ['metric-total', 'metric-sources', 'metric-http', 'metric-ssh']) $(id).textContent = '—';
  $('metric-retention').textContent = 'Retained observation window';
  $('metric-sessions').textContent = 'Emulated shell activity';
  $('event-count').textContent = '0';
  $('results-note').textContent = 'No activity loaded';
  renderTimeline([]);
  renderRanking('top-paths', [], 'path', 'No paths recorded yet.');
  renderRanking('top-sources', [], 'source', 'No sources recorded yet.');
  renderEmpty('The field log is quiet.', 'Unlock the console to see real sensor activity.');
  knownEvents = [];
  hasData = false;
  renderSamples(null);
  selectedId = null;
  ui.category.replaceChildren(make('option', '', 'All categories'));
  ui.category.firstChild.value = '';
  if (ui.inspector.open) ui.inspector.close();
  $('event-details').replaceChildren();
  $('event-json').textContent = '';
}
function lock(message = '') {
  generation += 1;
  controller?.abort();
  exportController?.abort();
  clearTimeout(pollTimer);
  clearTimeout(searchTimer);
  token = '';
  ui.token.value = '';
  paused = false;
  lastSuccess = null;
  ui.pause.replaceChildren(document.createTextNode('Ⅱ '), make('span', '', 'Pause'));
  ui.auth.classList.remove('hidden');
  ui.authError.textContent = message;
  setControls(false);
  setStatus('locked', 'LOCKED');
  ui.updated.textContent = 'Waiting for authentication';
  notice();
  resetData();
}
function schedule() {
  clearTimeout(pollTimer);
  if (token && !paused) pollTimer = setTimeout(() => refresh(), 5000);
}
async function getJson(path, signal, requestToken) {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/json' }, signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
async function refresh() {
  if (!token) return;
  clearTimeout(pollTimer);
  controller?.abort();
  const current = ++generation;
  const requestToken = token;
  const ownController = new AbortController();
  controller = ownController;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; ownController.abort(); }, 10000);
  ui.refresh.disabled = true;
  if (!hasData) setStatus('connecting', 'CONNECTING');
  const params = new URLSearchParams({ protocol, limit: '100' });
  if (ui.category.value) params.set('category', ui.category.value);
  if (ui.search.value.trim()) params.set('q', ui.search.value.trim());
  try {
    const [overview, results, samples] = await Promise.all([
      getJson('/api/overview', ownController.signal, requestToken),
      getJson(`/api/events?${params}`, ownController.signal, requestToken),
      getJson('/api/samples', ownController.signal, requestToken),
    ]);
    if (current !== generation || token !== requestToken) return;
    if (!overview || !results || !Array.isArray(results.events)) throw new Error('Unexpected response');
    sensorHealth = describeSensorHealth(overview.ingest);
    renderOverview(overview);
    renderEvents(results);
    renderSamples(samples);
    lastSuccess = new Date();
    hasData = true;
    ui.auth.classList.add('hidden');
    ui.authError.textContent = '';
    setControls(true);
    setStatus(paused ? 'paused' : sensorHealth.state, paused ? 'PAUSED' : sensorHealth.label);
    ui.updated.textContent = `Console updated ${clock(lastSuccess)} UTC · refreshes every 5s`;
    if (paused) ui.updated.textContent = `Snapshot at ${clock(lastSuccess)} UTC`;
    notice(sensorHealth.message);
  } catch (error) {
    if ((error.name === 'AbortError' && !timedOut) || current !== generation || token !== requestToken) return;
    if (error.status === 401 || error.status === 403) {
      lock('That token was not accepted. Check the server token and try again.');
      ui.token.focus();
      return;
    }
    setStatus('error', 'OFFLINE');
    const message = 'The sensors could not be reached. Check the server or SSH tunnel; automatic retries continue while unpaused.';
    notice(message);
    if (!hasData) ui.authError.textContent = 'Could not reach the console. Check your SSH tunnel and try again.';
    ui.updated.textContent = lastSuccess ? `Last successful update ${clock(lastSuccess)} UTC` : 'No sensor data received';
    setControls(true);
  } finally {
    clearTimeout(timeout);
    ownController.abort();
    if (current === generation && token === requestToken) {
      controller = null;
      ui.refresh.disabled = false;
      schedule();
    }
  }
}
function describeSensorHealth(ingest) {
  if (!ingest || !ingest.sources) return { state: 'waiting', label: 'STATUS UNKNOWN', message: 'The console is reachable; sensor ingestion status is not yet available.' };
  const sources = Object.entries(ingest.sources);
  const errors = sources.filter(([, source]) => source.status === 'error');
  if (errors.length) return { state: 'degraded', label: 'DEGRADED', message: `Sensor ingestion needs attention: ${errors.map(([name]) => name.toUpperCase()).join(', ')}. Retained observations remain visible.` };
  if (sources.length && sources.every(([, source]) => !Number(source.files))) return { state: 'waiting', label: 'AWAITING EVENTS', message: 'Awaiting sensor events. The console is reachable, but no sensor log files have been observed yet.' };
  if (ingest.status !== 'ok') return { state: 'degraded', label: 'DEGRADED', message: 'Sensor ingestion is starting or degraded. Retained observations remain visible; check the sensor services if this persists.' };
  return { state: 'live', label: 'LIVE', message: '' };
}
function renderOverview(data) {
  $('metric-total').textContent = count(data.total_events);
  $('metric-sources').textContent = count(data.sources);
  $('metric-http').textContent = count(data.http_events);
  $('metric-ssh').textContent = count(data.ssh_events);
  $('metric-retention').textContent = `Last ${count(data.retention_days)} days · retained events`;
  $('metric-sessions').textContent = `${count(data.sessions)} SSH sessions observed`;
  renderTimeline(Array.isArray(data.events_per_hour) ? data.events_per_hour : []);
  renderRanking('top-paths', data.top_paths, 'path', 'No paths recorded yet.');
  renderRanking('top-sources', data.top_sources, 'source', 'No sources recorded yet.');
  const selectedCategory = ui.category.value;
  const categories = Array.isArray(data.categories) ? data.categories.map((v) => typeof v === 'string' ? v : v.category).filter((v) => typeof v === 'string' && v.length <= 100) : [];
  const options = [make('option', '', 'All categories')];
  options[0].value = '';
  for (const category of [...new Set(categories)].sort()) {
    const option = make('option', '', category);
    option.value = category;
    options.push(option);
  }
  if (selectedCategory && !categories.includes(selectedCategory)) {
    const option = make('option', '', selectedCategory);
    option.value = selectedCategory;
    options.push(option);
  }
  ui.category.replaceChildren(...options);
  ui.category.value = selectedCategory;
}
function bytes(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n % (1024 ** 2) ? 1 : 0)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} KiB`;
  return `${count(n)} B`;
}
function renderSamples(data) {
  const samples = Array.isArray(data?.samples) ? data.samples.slice(0, 256) : [];
  const total = Math.max(0, Number(data?.total_bytes) || 0);
  const capacity = Math.max(1, Number(data?.max_total_bytes) || 134217728);
  const percentage = Math.min(100, total / capacity * 100);
  $('sample-count').textContent = data ? count(samples.length) : '0';
  $('sample-storage').textContent = data ? bytes(total) : '—';
  $('sample-capacity').textContent = data ? bytes(capacity) : '—';
  $('sample-limits').textContent = data ? `${bytes(data.max_sample_bytes)} / sample · ${count(data.max_samples)} object limit` : 'Bounded, private storage';
  $('sample-meter-fill').style.width = `${percentage}%`;
  document.querySelector('.sample-meter').setAttribute('aria-valuenow', percentage.toFixed(1));
  $('sample-feedback').textContent = '';
  const body = $('samples-body');
  if (!samples.length) {
    const row = make('tr');
    const cell = make('td', 'samples-empty', data ? 'No samples retained. Unclassified objects will appear here without being executed.' : 'Unlock the console to inspect the private sample inventory.');
    cell.colSpan = 3;
    row.append(cell);
    body.replaceChildren(row);
    return;
  }
  body.replaceChildren(...samples.map((sample) => {
    const row = make('tr');
    const hashCell = make('td', 'sample-hash-cell');
    const hash = text(sample.sha256).slice(0, 128);
    const hashLabel = make('code', 'sample-hash', hash);
    hashLabel.title = hash;
    const copy = make('button', 'copy-hash', 'Copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', `Copy SHA-256 ${hash}`);
    copy.disabled = !/^[a-f0-9]{64}$/i.test(hash);
    copy.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(hash);
        $('sample-feedback').textContent = 'SHA-256 copied.';
      } catch {
        $('sample-feedback').textContent = 'Select the hash text to copy it manually.';
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(hashLabel);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
    hashCell.append(hashLabel, copy);
    const size = make('td', 'sample-size', bytes(sample.size));
    const seen = make('td', 'event-time', `${day(sample.first_seen)} · ${clock(sample.first_seen)}`);
    row.append(hashCell, size, seen);
    return row;
  }));
}
function renderTimeline(rows) {
  const chart = $('chart');
  const validRows = rows.slice(-48).map((row) => ({ hour: row.hour, count: Math.max(0, Number(row.count) || 0) }));
  chart.replaceChildren();
  if (!validRows.length || !validRows.some((row) => row.count > 0)) {
    chart.append(make('div', 'chart-empty', token ? 'No recorded activity in this time window.' : 'Observation begins with the first knock.'));
    chart.setAttribute('aria-label', 'No recorded activity in the hourly time window');
  } else {
    const max = Math.max(...validRows.map((row) => row.count), 1);
    for (const row of validRows) {
      const column = make('div', 'chart-column');
      column.title = `${day(row.hour)} ${clock(row.hour).slice(0, 5)} UTC · ${count(row.count)} events`;
      const bar = make('span', 'chart-bar');
      bar.style.height = `${row.count ? Math.max(2, row.count / max * 100) : 0}%`;
      if (!row.count) bar.style.opacity = '.15';
      column.append(bar);
      chart.append(column);
    }
    chart.setAttribute('aria-label', `Hourly activity: ${validRows.map((row) => `${clock(row.hour).slice(0, 5)} UTC, ${count(row.count)} events`).join('; ')}`);
  }
  const labelRows = validRows.length ? [validRows[0], validRows[Math.floor((validRows.length - 1) / 2)], validRows[validRows.length - 1]] : [];
  $('chart-labels').replaceChildren(...(labelRows.length ? labelRows.map((row) => make('span', '', `${day(row.hour)} · ${clock(row.hour).slice(0, 5)}`)) : [make('span', '', '—'), make('span', '', '—'), make('span', '', '—')]));
}
function renderRanking(id, rows, key, emptyMessage) {
  const list = $(id);
  const items = Array.isArray(rows) ? rows.slice(0, 5) : [];
  if (!items.length) { list.replaceChildren(make('li', 'ranking-empty', emptyMessage)); return; }
  const max = Math.max(...items.map((row) => Number(row.count) || 0), 1);
  list.replaceChildren(...items.map((row, index) => {
    const item = make('li');
    const label = make('span', 'ranking-label', row[key]);
    label.title = text(row[key]);
    const bar = make('span', 'ranking-bar');
    bar.style.width = `${Math.max(0, Math.min(100, (Number(row.count) || 0) / max * 80))}%`;
    item.append(make('span', 'ranking-number', String(index + 1).padStart(2, '0')), label, make('span', 'ranking-count', count(row.count)), bar);
    return item;
  }));
}
function renderEmpty(title, explanation) {
  const cell = make('td', 'table-empty');
  cell.colSpan = 7;
  cell.append(make('span', 'empty-symbol', '⌁'), make('strong', '', title), make('span', '', explanation));
  const row = make('tr'); row.append(cell); ui.body.replaceChildren(row);
}
function renderEvents(data) {
  knownEvents = data.events.slice(0, 100);
  $('event-count').textContent = count(data.total ?? knownEvents.length);
  $('results-note').textContent = `${count(knownEvents.length)} shown · ${count(data.total ?? knownEvents.length)} matching retained events`;
  if (!knownEvents.length) {
    renderEmpty('No encounters in view.', ui.search.value.trim() || ui.category.value || protocol !== 'all' ? 'Try a different search or filter.' : sensorHealth.message || 'No observations recorded yet. New encounters will appear here.');
    return;
  }
  ui.body.replaceChildren(...knownEvents.map((event) => {
    const row = make('tr', 'event-row');
    const time = make('td', 'event-time', clock(event.timestamp));
    time.append(make('small', '', day(event.timestamp)));
    const sensor = make('td');
    const kind = event.protocol === 'ssh' ? 'ssh' : 'http';
    sensor.append(make('span', `protocol-badge ${kind}`, kind.toUpperCase()));
    const source = make('td', 'source-cell', event.source);
    source.title = text(event.source);
    const encounter = make('td', 'encounter-cell');
    if (event.method) encounter.append(make('span', 'method', event.method));
    encounter.append(document.createTextNode(text(event.path || event.detail || event.event)));
    encounter.title = text(event.path || event.detail || event.event);
    const category = make('td', 'category-cell', event.category);
    const result = make('td');
    result.append(make('span', `result-badge ${Number(event.status) >= 400 ? 'warning' : ''}`, event.status || (kind === 'ssh' ? text(event.event).replace(/^cowrie\./, '').split('.').slice(-1)[0] : '—')));
    const control = make('td');
    const open = make('button', 'event-open', '↗');
    open.type = 'button';
    open.setAttribute('aria-label', `Inspect ${kind.toUpperCase()} encounter at ${clock(event.timestamp)} UTC`);
    open.addEventListener('click', (e) => { e.stopPropagation(); inspect(event); });
    control.append(open);
    row.append(time, sensor, source, encounter, category, result, control);
    row.addEventListener('click', () => inspect(event));
    return row;
  }));
  if (selectedId != null && ui.inspector.open) {
    const updated = knownEvents.find((event) => event.id === selectedId);
    if (updated) fillInspector(updated);
  }
}
function fillInspector(event) {
  $('inspector-title').textContent = event.protocol === 'ssh' ? 'An SSH encounter' : 'An HTTP encounter';
  const pairs = [['Observed', validDate(event.timestamp)?.toISOString() || '—'], ['Sensor', text(event.protocol).toUpperCase()], ['Source', event.source], ['Event', event.event], ['Category', event.category], ['Method', event.method], ['Path', event.path], ['Result', event.status], ['Session', event.session], ['User agent', event.user_agent], ['Detail', event.detail]].filter(([label, value]) => value != null && value !== '');
  $('event-details').replaceChildren(...pairs.flatMap(([label, value]) => [make('dt', '', label), make('dd', '', value)]));
  $('event-json').textContent = JSON.stringify(event, null, 2);
}
function inspect(event) {
  selectedId = event.id;
  fillInspector(event);
  if (!ui.inspector.open) ui.inspector.showModal();
}
function filtersChanged() {
  clearTimeout(searchTimer);
  generation += 1;
  controller?.abort();
  if (token) refresh();
}
ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const candidate = ui.token.value.trim();
  if (candidate.length < 16) { ui.authError.textContent = 'Enter the complete console token from your server.'; return; }
  token = candidate;
  ui.token.value = '';
  ui.authError.textContent = '';
  paused = false;
  refresh();
});
ui.lock.addEventListener('click', () => { lock(); ui.token.focus(); });
ui.refresh.addEventListener('click', () => refresh());
ui.pause.addEventListener('click', () => {
  paused = !paused;
  clearTimeout(pollTimer);
  ui.pause.replaceChildren(document.createTextNode(paused ? '▷ ' : 'Ⅱ '), make('span', '', paused ? 'Resume' : 'Pause'));
  if (paused) {
    generation += 1;
    controller?.abort();
    controller = null;
    ui.refresh.disabled = false;
    setStatus('paused', 'PAUSED');
    ui.updated.textContent = lastSuccess ? `Snapshot at ${clock(lastSuccess)} UTC` : 'Automatic updates paused';
  } else refresh();
});
for (const button of document.querySelectorAll('[data-protocol]')) {
  button.addEventListener('click', () => {
    protocol = button.dataset.protocol;
    for (const candidate of document.querySelectorAll('[data-protocol]')) {
      const active = candidate === button;
      candidate.classList.toggle('active', active);
      candidate.setAttribute('aria-pressed', String(active));
    }
    filtersChanged();
  });
}
ui.category.addEventListener('change', filtersChanged);
ui.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  generation += 1;
  controller?.abort();
  clearTimeout(pollTimer);
  searchTimer = setTimeout(() => { if (token) refresh(); }, 250);
});
ui.export.addEventListener('click', async () => {
  if (!token || exportController) return;
  const requestToken = token;
  const ownController = new AbortController();
  exportController = ownController;
  let exportTimedOut = false;
  const exportTimeout = setTimeout(() => { exportTimedOut = true; ownController.abort(); }, 15000);
  ui.export.disabled = true;
  try {
    const response = await fetch('/api/export', { headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/x-ndjson' }, signal: ownController.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) { lock('Your token was not accepted. Unlock the console again.'); return; }
      throw new Error('Export failed');
    }
    const blob = await response.blob();
    if (token !== requestToken) return;
    const url = URL.createObjectURL(blob);
    const link = make('a');
    link.href = url;
    link.download = `nightjar-events-${new Date().toISOString().slice(0, 10)}.ndjson`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    if ((error.name !== 'AbortError' || exportTimedOut) && token === requestToken) notice('Export could not be downloaded. Check the SSH tunnel and try again.');
  } finally {
    clearTimeout(exportTimeout);
    exportController = null;
    ui.export.disabled = !token;
  }
});
$('close-inspector').addEventListener('click', () => ui.inspector.close());
ui.inspector.addEventListener('click', (event) => {
  if (event.target === ui.inspector) {
    const box = ui.inspector.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) ui.inspector.close();
  }
});
ui.inspector.addEventListener('close', () => { selectedId = null; });
window.addEventListener('pagehide', () => {
  token = '';
  generation += 1;
  controller?.abort();
  exportController?.abort();
  clearTimeout(pollTimer);
  clearTimeout(searchTimer);
});
$('footer-time').textContent = `${day(new Date()).toUpperCase()} · ALL TIMES UTC`;
