/**
 * The portal's single page, embedded as a string.
 *
 * No bundler and no framework: `tsc` stays the only build step, there is
 * nothing to copy into dist, and the whole UI is auditable in one file — which
 * matters for a page that renders third-party job text under a strict CSP.
 *
 * Configuration is expressed as pickable options rather than comma-separated
 * text. Typing "engineer, architect" into a box means guessing our matching
 * rules; picking "Software engineering" does not.
 */

const STYLES = String.raw`
:root {
  --bg: #0c0d10;
  --surface: #131519;
  --surface-2: #171a1f;
  --line: #23262d;
  --line-strong: #2f333c;
  --text: #e8eaed;
  --muted: #9aa1ad;
  --faint: #6b7280;
  --accent: #34d399;
  --accent-dim: #0f2f24;
  --warn: #d9a441;
  --danger: #e5766b;
  --radius: 14px;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
}
* { box-sizing: border-box; }
html { color-scheme: dark; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--accent-dim); }

/* Asymmetric shell: content rail plus a narrower sticky summary. */
.shell {
  display: grid;
  grid-template-columns: minmax(0, 2.15fr) minmax(0, 1fr);
  gap: 40px;
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 32px 96px;
  align-items: start;
}
@media (max-width: 940px) {
  .shell { grid-template-columns: 1fr; gap: 24px; padding: 0 16px 64px; }
  aside { position: static !important; }
}

header {
  max-width: 1180px;
  margin: 0 auto;
  padding: 30px 32px 26px;
  display: flex;
  align-items: baseline;
  gap: 14px;
}
@media (max-width: 940px) { header { padding: 22px 16px 18px; } }
.brand { font-size: 16px; font-weight: 640; letter-spacing: -0.01em; }
.brand span { color: var(--accent); }
.tagline { color: var(--faint); font-size: 13px; }

section {
  border-top: 1px solid var(--line);
  padding: 28px 0 4px;
  animation: rise 0.5s var(--ease) both;
  animation-delay: calc(var(--i, 0) * 60ms);
}
section:first-of-type { border-top: 0; padding-top: 8px; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }

h2 { font-size: 15px; margin: 0 0 3px; font-weight: 600; letter-spacing: -0.01em; }
.hint { color: var(--muted); font-size: 13px; margin: 0 0 18px; max-width: 62ch; }
.label { font-size: 12px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.06em; margin: 20px 0 9px; }

/* Chips carry almost all configuration. */
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  display: inline-flex; align-items: center; gap: 8px;
  border: 1px solid var(--line-strong); background: var(--surface);
  color: var(--text); border-radius: 999px; padding: 8px 14px;
  font-size: 13.5px; cursor: pointer; user-select: none;
  transition: background 0.18s var(--ease), border-color 0.18s var(--ease), transform 0.12s var(--ease);
}
.chip:hover { border-color: var(--faint); }
.chip:active { transform: scale(0.975); }
.chip[aria-pressed="true"] { background: var(--accent-dim); border-color: var(--accent); color: #d6ffe9; }
.chip .sub { color: var(--faint); font-size: 12px; }
.chip[aria-pressed="true"] .sub { color: #7fcfae; }
.chip .tick { width: 13px; height: 13px; opacity: 0; transition: opacity 0.18s var(--ease); }
.chip[aria-pressed="true"] .tick { opacity: 1; }

.scale { display: flex; flex-wrap: wrap; gap: 8px; }
.scale .chip { min-width: 84px; justify-content: center; font-variant-numeric: tabular-nums; }

.toggle { display: flex; align-items: flex-start; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.toggle:last-of-type { border-bottom: 0; }
.toggle .copy { flex: 1; }
.toggle .copy b { display: block; font-weight: 500; font-size: 14px; }
.toggle .copy span { color: var(--muted); font-size: 12.5px; }
.switch {
  appearance: none; width: 40px; height: 23px; border-radius: 999px; flex: none; margin-top: 2px;
  background: var(--surface-2); border: 1px solid var(--line-strong); position: relative; cursor: pointer;
  transition: background 0.2s var(--ease), border-color 0.2s var(--ease);
}
.switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%;
  background: var(--faint); transition: transform 0.22s var(--ease), background 0.22s var(--ease);
}
.switch:checked { background: var(--accent-dim); border-color: var(--accent); }
.switch:checked::after { transform: translateX(17px); background: var(--accent); }
.switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Company catalog */
.search { position: relative; margin-bottom: 14px; }
.search input { padding-left: 36px; }
.search svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--faint); }
input[type="text"], input[type="number"], select {
  width: 100%; background: var(--surface); color: var(--text);
  border: 1px solid var(--line-strong); border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 14px;
}
input::placeholder { color: var(--faint); }
input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }

.catalog { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; max-height: 330px; overflow: auto; padding-right: 4px; }
.co {
  display: flex; align-items: center; gap: 10px; text-align: left; width: 100%;
  border: 1px solid var(--line); background: var(--surface); color: var(--text);
  border-radius: 10px; padding: 10px 12px; cursor: pointer; font: inherit;
  transition: border-color 0.18s var(--ease), background 0.18s var(--ease), transform 0.12s var(--ease);
}
.co:hover { border-color: var(--line-strong); }
.co:active { transform: scale(0.985); }
.co[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-dim); }
.co .mark {
  width: 26px; height: 26px; border-radius: 7px; flex: none; display: grid; place-items: center;
  background: var(--surface-2); color: var(--muted); font-size: 11.5px; font-weight: 600;
}
.co[aria-pressed="true"] .mark { background: var(--accent); color: #06241a; }
.co .who { min-width: 0; }
.co .who b { display: block; font-weight: 500; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.co .who span { color: var(--faint); font-size: 11.5px; }

.rowline { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.count { color: var(--faint); font-size: 12.5px; font-variant-numeric: tabular-nums; }

details.adv { margin-top: 22px; border-top: 1px solid var(--line); padding-top: 16px; }
details.adv summary { cursor: pointer; color: var(--muted); font-size: 13px; list-style: none; }
details.adv summary::-webkit-details-marker { display: none; }
details.adv summary::before { content: "+ "; color: var(--faint); }
details.adv[open] summary::before { content: "- "; }
details.adv .body { padding-top: 14px; display: grid; gap: 14px; }

/* Sticky summary rail */
aside { position: sticky; top: 28px; display: grid; gap: 14px; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px 18px 16px; }
.panel h3 { margin: 0 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); font-weight: 600; }
.kv { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.kv:last-child { border-bottom: 0; }
.kv span { color: var(--muted); }
.kv b { font-weight: 500; font-variant-numeric: tabular-nums; text-align: right; }
.metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.metric .n { font-size: 21px; font-weight: 620; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.metric .l { color: var(--faint); font-size: 11.5px; }

button.primary {
  width: 100%; background: var(--accent); color: #06241a; border: 0; border-radius: 10px;
  padding: 11px 16px; font: inherit; font-weight: 600; cursor: pointer;
  transition: transform 0.12s var(--ease), filter 0.18s var(--ease);
}
button.primary:hover { filter: brightness(1.06); }
button.primary:active { transform: translateY(1px) scale(0.99); }
button.primary:disabled { opacity: 0.55; cursor: default; transform: none; }
button.ghost {
  background: transparent; color: var(--text); border: 1px solid var(--line-strong);
  border-radius: 10px; padding: 9px 14px; font: inherit; font-size: 13.5px; cursor: pointer;
  transition: border-color 0.18s var(--ease), transform 0.12s var(--ease);
}
button.ghost:hover { border-color: var(--faint); }
button.ghost:active { transform: scale(0.98); }

.status { font-size: 12.5px; color: var(--muted); min-height: 18px; margin-top: 10px; }
.status.ok { color: var(--accent); }
.status.bad { color: var(--danger); }
.problems { margin-top: 10px; display: grid; gap: 5px; }
.problems div { color: var(--danger); font-size: 12.5px; }

.empty { color: var(--faint); font-size: 13px; padding: 22px 0; text-align: center; border: 1px dashed var(--line-strong); border-radius: 10px; }
.skeleton { height: 46px; border-radius: 10px; background: linear-gradient(90deg, var(--surface) 25%, var(--surface-2) 37%, var(--surface) 63%); background-size: 400% 100%; animation: shimmer 1.4s ease-in-out infinite; }
@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }

.preview ul { list-style: none; margin: 12px 0 0; padding: 0; max-height: 240px; overflow: auto; }
.preview li { padding: 7px 0; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--muted); display: flex; gap: 12px; }
.preview li b { color: var(--text); font-weight: 500; flex: 1; min-width: 0; }
.preview li i { font-style: normal; color: var(--faint); font-size: 12px; white-space: nowrap; }

footer { max-width: 1180px; margin: 0 auto; padding: 0 32px 48px; color: var(--faint); font-size: 12px; }
code { background: var(--surface); border: 1px solid var(--line); padding: 2px 7px; border-radius: 6px; font-size: 11.5px; }
`;

const SCRIPT = String.raw`
const token = new URLSearchParams(location.search).get('token') || '';
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-roleeye-token': token, ...(options.headers || {}) },
  });
  return { ok: response.ok, payload: await response.json().catch(() => ({})) };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Built as nodes, not markup: this page never assigns innerHTML, anywhere. */
function tickIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'tick');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3 8.5 6.5 12 13 4');
  svg.append(path);

  return svg;
}

const state = {
  presets: null,
  catalog: [],
  categories: {},
  selection: {
    families: [], seniority: [], locations: [], metros: [], remoteOnly: false,
    postedWithinDays: 60, salaryFloor: 0, refuseSystems: [], rejectRelocation: true,
    screeningEnabled: true, captureMode: 'scoped', catalog: [], extraTitles: [], extraExcludes: [],
  },
  filter: '',
};

function toggle(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
  else list.push(value);
}

function chip(label, sub, pressed, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chip';
  button.setAttribute('aria-pressed', String(pressed));
  button.append(tickIcon());

  const text = document.createElement('span');
  text.textContent = label;
  button.append(text);

  if (sub) {
    const small = document.createElement('span');
    small.className = 'sub';
    small.textContent = sub;
    button.append(small);
  }

  button.onclick = () => { onClick(); render(); };
  return button;
}

function money(value) {
  return value === 0 ? 'Any' : '$' + Math.round(value / 1000) + 'k';
}

function renderFamilies() {
  const host = $('families');
  host.replaceChildren(
    ...state.presets.families.map((family) =>
      chip(family.label, family.hint, state.selection.families.includes(family.id), () =>
        toggle(state.selection.families, family.id),
      ),
    ),
  );
}

function renderSeniority() {
  const host = $('seniority');
  host.replaceChildren(
    ...state.presets.seniority.map((option) =>
      chip(option.label, '', state.selection.seniority.includes(option.id), () =>
        toggle(state.selection.seniority, option.id),
      ),
    ),
  );
}

function renderLocations() {
  $('locations').replaceChildren(
    ...state.presets.locations.map((option) =>
      chip(option.label, '', state.selection.locations.includes(option.id), () =>
        toggle(state.selection.locations, option.id),
      ),
    ),
  );
  $('metros').replaceChildren(
    ...state.presets.metros.map((metro) =>
      chip(metro.replace(/\b\w/g, (c) => c.toUpperCase()), '', state.selection.metros.includes(metro), () =>
        toggle(state.selection.metros, metro),
      ),
    ),
  );
}

function renderSalary() {
  $('salary').replaceChildren(
    ...state.presets.salarySteps.map((step) =>
      chip(money(step), '', state.selection.salaryFloor === step, () => { state.selection.salaryFloor = step; }),
    ),
  );
}

function renderSystems() {
  $('systems').replaceChildren(
    ...state.presets.applicationSystems.map((system) =>
      chip(system.label, system.hint, state.selection.refuseSystems.includes(system.id), () =>
        toggle(state.selection.refuseSystems, system.id),
      ),
    ),
  );
}

function renderRecency() {
  const options = [[14, '2 weeks'], [30, '30 days'], [60, '60 days'], [90, '90 days'], [0, 'Any age']];
  $('recency').replaceChildren(
    ...options.map(([days, label]) =>
      chip(label, '', (state.selection.postedWithinDays || 0) === days, () => {
        state.selection.postedWithinDays = days === 0 ? undefined : days;
      }),
    ),
  );
}

function renderCatalog() {
  const host = $('catalog');
  const term = state.filter.trim().toLowerCase();
  const matches = state.catalog.filter(
    (entry) =>
      !term ||
      entry.company.toLowerCase().includes(term) ||
      (state.categories[entry.category] || '').toLowerCase().includes(term),
  );

  host.replaceChildren();

  if (!state.catalog.length) {
    const loading = document.createElement('div');
    loading.className = 'catalog';
    for (let i = 0; i < 6; i += 1) {
      const bone = document.createElement('div');
      bone.className = 'skeleton';
      loading.append(bone);
    }
    host.replaceWith(loading);
    loading.id = 'catalog';
    return;
  }

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No companies match "' + state.filter + '". Add any board by URL below.';
    host.append(empty);
    return;
  }

  for (const entry of matches) {
    const key = entry.type + ':' + entry.token;
    const picked = state.selection.catalog.includes(key);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'co';
    button.setAttribute('aria-pressed', String(picked));

    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = entry.company.slice(0, 2).toUpperCase();

    const who = document.createElement('span');
    who.className = 'who';
    const name = document.createElement('b');
    name.textContent = entry.company;
    const cat = document.createElement('span');
    cat.textContent = state.categories[entry.category] || entry.category;
    who.append(name, cat);

    button.append(mark, who);
    button.onclick = () => { toggle(state.selection.catalog, key); render(); };
    host.append(button);
  }
}

function renderSummary() {
  const roles = state.presets.families.filter((f) => state.selection.families.includes(f.id)).map((f) => f.label);
  const rows = [
    ['Companies', state.selection.catalog.length || 'none picked'],
    ['Role families', roles.length ? roles.length : 'any'],
    ['Seniority', state.selection.seniority.length ? state.selection.seniority.length + ' levels' : 'any'],
    ['Locations', state.selection.locations.length ? state.selection.locations.length : 'any'],
    ['Salary floor', money(state.selection.salaryFloor)],
    ['Refusing', state.selection.refuseSystems.length ? state.selection.refuseSystems.join(', ') : 'nothing'],
  ];

  const host = $('summary');
  host.replaceChildren();
  for (const [key, value] of rows) {
    const row = document.createElement('div');
    row.className = 'kv';
    const k = document.createElement('span');
    k.textContent = key;
    const v = document.createElement('b');
    v.textContent = String(value);
    row.append(k, v);
    host.append(row);
  }
}

function render() {
  renderFamilies();
  renderSeniority();
  renderLocations();
  renderSalary();
  renderSystems();
  renderRecency();
  renderCatalog();
  renderSummary();
  $('remoteOnly').checked = state.selection.remoteOnly;
  $('rejectRelocation').checked = state.selection.rejectRelocation;
  $('screeningEnabled').checked = state.selection.screeningEnabled;
}

async function save() {
  const status = $('saveStatus');
  status.className = 'status';
  status.textContent = 'Saving...';

  state.selection.extraTitles = $('extraTitles').value.split(',').map((s) => s.trim()).filter(Boolean);
  state.selection.extraExcludes = $('extraExcludes').value.split(',').map((s) => s.trim()).filter(Boolean);
  state.selection.captureMode = $('captureMode').value;

  const { ok, payload } = await api('/api/preferences', { method: 'PUT', body: JSON.stringify(state.selection) });

  const problems = $('problems');
  problems.replaceChildren();
  (payload.problems || []).forEach((problem) => {
    const line = document.createElement('div');
    line.textContent = problem.path + ': ' + problem.message;
    problems.append(line);
  });

  if (ok) {
    status.className = 'status ok';
    status.textContent = 'Saved. Run roleeye scan, or wait for the scheduled run.';
    loadStatus();
  } else {
    status.className = 'status bad';
    status.textContent = 'Nothing was written. See below.';
  }
}

async function addByUrl() {
  const entry = $('boardEntry').value.trim();
  if (!entry) return;

  const status = $('boardStatus');
  status.className = 'status';
  status.textContent = 'Checking that board...';

  const { payload } = await api('/api/board-check', { method: 'POST', body: JSON.stringify({ entry }) });

  if (!payload.ok) {
    status.className = 'status bad';
    status.textContent = payload.reason || 'Could not verify that board.';
    return;
  }

  const key = payload.type + ':' + payload.token;
  if (!state.catalog.some((e) => e.type + ':' + e.token === key)) {
    state.catalog.unshift({ company: payload.token, type: payload.type, token: payload.token, category: 'custom' });
    state.categories.custom = 'Added by you';
  }
  if (!state.selection.catalog.includes(key)) state.selection.catalog.push(key);

  status.className = 'status ok';
  status.textContent = 'Added ' + payload.token + ' - ' + payload.openRoles + ' roles open right now.';
  $('boardEntry').value = '';
  render();
}

async function preview() {
  const host = $('previewOut');
  host.replaceChildren();
  const bone = document.createElement('div');
  bone.className = 'skeleton';
  host.append(bone);

  const { payload } = await api('/api/scope-preview', { method: 'POST', body: JSON.stringify({}) });
  host.replaceChildren();

  if (payload.error) {
    const line = document.createElement('div');
    line.className = 'status bad';
    line.textContent = payload.error;
    host.append(line);
    return;
  }

  if (!payload.evaluated) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing stored yet. Save, then run roleeye scan to see what these settings keep.';
    host.append(empty);
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'status';
  summary.textContent = payload.kept + ' kept, ' + payload.dropped + ' dropped, of ' + payload.evaluated + ' stored roles.';
  host.append(summary);

  const list = document.createElement('ul');
  (payload.droppedSample || []).slice(0, 12).forEach((job) => {
    const item = document.createElement('li');
    const title = document.createElement('b');
    title.textContent = job.company + ' - ' + job.title;
    const why = document.createElement('i');
    why.textContent = job.reason;
    item.append(title, why);
    list.append(item);
  });
  host.append(list);
}

async function loadStatus() {
  const { payload } = await api('/api/status');
  $('statJobs').textContent = payload.jobs;
  $('statSources').textContent = payload.sources.enabled;
}

async function load() {
  const [presets, config, catalog] = await Promise.all([
    api('/api/presets'),
    api('/api/config'),
    api('/api/catalog'),
  ]);

  state.presets = presets.payload;
  state.catalog = catalog.payload.entries || [];
  state.categories = catalog.payload.categories || {};
  Object.assign(state.selection, config.payload.selection || {});
  state.selection.captureMode = config.payload.captureMode || 'scoped';
  state.selection.catalog = state.catalog.filter((e) => e.added).map((e) => e.type + ':' + e.token);

  $('captureMode').value = state.selection.captureMode;
  $('extraTitles').value = (state.selection.extraTitles || []).join(', ');
  $('extraExcludes').value = (state.selection.extraExcludes || []).join(', ');
  $('paths').textContent = config.payload.locations.criteria;

  render();
  loadStatus();
}

$('search').addEventListener('input', (e) => { state.filter = e.target.value; renderCatalog(); });
$('addUrl').onclick = addByUrl;
$('boardEntry').addEventListener('keydown', (e) => { if (e.key === 'Enter') addByUrl(); });
$('save').onclick = save;
$('preview').onclick = preview;
$('remoteOnly').onchange = (e) => { state.selection.remoteOnly = e.target.checked; renderSummary(); };
$('rejectRelocation').onchange = (e) => { state.selection.rejectRelocation = e.target.checked; };
$('screeningEnabled').onchange = (e) => { state.selection.screeningEnabled = e.target.checked; };
load();
`;

export function renderIndex(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RoleEye</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <span class="brand">Role<span>Eye</span></span>
  <span class="tagline">everything stays on this machine</span>
</header>

<div class="shell">
  <main>
    <section style="--i:0">
      <h2>Companies to watch</h2>
      <p class="hint">Pick from boards already verified as reachable, or add any other by URL.</p>
      <div class="search">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3" stroke-linecap="round"/></svg>
        <input type="text" id="search" placeholder="Search companies, or a category like fintech">
      </div>
      <div class="catalog" id="catalog"></div>
      <details class="adv">
        <summary>Add a company that is not listed</summary>
        <div class="body">
          <input type="text" id="boardEntry" placeholder="https://boards.greenhouse.io/yourcompany">
          <div><button class="ghost" id="addUrl" type="button">Check and add</button></div>
          <div class="status" id="boardStatus"></div>
        </div>
      </details>
    </section>

    <section style="--i:1">
      <h2>Roles you want</h2>
      <p class="hint">Each family expands into the title matching RoleEye uses. Pick none to allow any title.</p>
      <div class="chips" id="families"></div>

      <div class="label">Seniority</div>
      <div class="chips" id="seniority"></div>
    </section>

    <section style="--i:2">
      <h2>Where</h2>
      <p class="hint">Remote roles are never dropped for their country.</p>
      <div class="chips" id="locations"></div>

      <div class="label">Metros, optional</div>
      <div class="chips" id="metros"></div>

      <div class="toggle" style="margin-top:18px">
        <input class="switch" type="checkbox" id="remoteOnly">
        <span class="copy"><b>Remote only</b><span>Drop anything that is not fully remote</span></span>
      </div>
    </section>

    <section style="--i:3">
      <h2>Your rules</h2>
      <p class="hint">Applied deterministically before anything is evaluated. A rejection always names the rule.</p>

      <div class="label">Minimum base salary</div>
      <div class="scale" id="salary"></div>

      <div class="label">Posted within</div>
      <div class="scale" id="recency"></div>

      <div class="label">Refuse these application systems</div>
      <div class="chips" id="systems"></div>

      <div style="margin-top:20px">
        <div class="toggle">
          <input class="switch" type="checkbox" id="rejectRelocation">
          <span class="copy"><b>Reject roles requiring relocation</b><span>Based on wording in the posting</span></span>
        </div>
        <div class="toggle">
          <input class="switch" type="checkbox" id="screeningEnabled">
          <span class="copy"><b>Screen for ghost jobs and scams</b><span>Deterministic signals, no model involved</span></span>
        </div>
      </div>

      <details class="adv">
        <summary>Advanced</summary>
        <div class="body">
          <div>
            <div class="label" style="margin-top:0">Extra title terms to include</div>
            <input type="text" id="extraTitles" placeholder="rewards, loyalty">
          </div>
          <div>
            <div class="label" style="margin-top:0">Extra title terms to exclude</div>
            <input type="text" id="extraExcludes" placeholder="intern, contract">
          </div>
          <div>
            <div class="label" style="margin-top:0">Capture mode</div>
            <select id="captureMode">
              <option value="scoped">Scoped - store only relevant roles</option>
              <option value="full">Full - store everything, flag relevance</option>
              <option value="history">History - metadata only, market record</option>
            </select>
          </div>
        </div>
      </details>
    </section>

    <section style="--i:4">
      <h2>Check before you commit</h2>
      <p class="hint">Runs your settings against roles already stored. Nothing is written.</p>
      <button class="ghost" id="preview" type="button">Preview against stored roles</button>
      <div class="preview" id="previewOut"></div>
    </section>
  </main>

  <aside>
    <div class="panel">
      <h3>Selection</h3>
      <div id="summary"></div>
    </div>

    <div class="panel">
      <h3>Local record</h3>
      <div class="metrics">
        <div class="metric"><div class="n" id="statJobs">0</div><div class="l">roles stored</div></div>
        <div class="metric"><div class="n" id="statSources">0</div><div class="l">sources on</div></div>
      </div>
    </div>

    <div class="panel">
      <button class="primary" id="save" type="button">Save configuration</button>
      <div class="status" id="saveStatus"></div>
      <div class="problems" id="problems"></div>
    </div>
  </aside>
</div>

<footer>
  Writes <code id="paths"></code> and the sources file beside it. The CLI reads the same files,
  validated by the same rules. Nothing here calls a model or leaves this machine.
</footer>

<script>${SCRIPT}</script>
</body>
</html>`;
}
