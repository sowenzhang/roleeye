/**
 * The portal's single page, embedded as a string.
 *
 * No bundler and no framework: keeping it a plain module means `tsc` remains
 * the only build step, there is nothing to copy into dist, and the whole UI is
 * auditable in one file — which matters for a page that renders third-party
 * job text.
 */

const STYLES = `
:root {
  --bg: #0f1115; --panel: #171a21; --line: #272c36; --text: #e6e8ee;
  --muted: #99a1b3; --accent: #6ea8fe; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { padding: 20px 28px; border-bottom: 1px solid var(--line); display: flex; align-items: baseline; gap: 14px; }
h1 { font-size: 17px; margin: 0; font-weight: 650; letter-spacing: .2px; }
header .sub { color: var(--muted); font-size: 13px; }
main { max-width: 900px; margin: 0 auto; padding: 24px 28px 80px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 20px 22px; margin-bottom: 18px; }
h2 { font-size: 14px; margin: 0 0 4px; font-weight: 600; }
p.hint { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
label { display: block; font-size: 13px; color: var(--muted); margin: 14px 0 5px; }
input, select, textarea {
  width: 100%; background: #0d1016; color: var(--text); border: 1px solid var(--line);
  border-radius: 7px; padding: 9px 11px; font: inherit; font-size: 14px;
}
input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
textarea { min-height: 62px; resize: vertical; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.check { display: flex; align-items: center; gap: 9px; margin: 14px 0 0; }
.check input { width: auto; }
.check label { margin: 0; color: var(--text); font-size: 14px; }
button {
  background: var(--accent); color: #0b1020; border: 0; border-radius: 7px;
  padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer;
}
button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); font-weight: 500; }
button:disabled { opacity: .5; cursor: default; }
.actions { display: flex; gap: 10px; align-items: center; margin-top: 20px; }
.status { font-size: 13px; color: var(--muted); }
.status.ok { color: var(--ok); }
.status.bad { color: var(--bad); }
.boards { margin-top: 8px; }
.board {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid var(--line);
  border-radius: 7px; margin-bottom: 8px; font-size: 14px; background: #0d1016;
}
.board .name { font-weight: 600; }
.board .meta { color: var(--muted); font-size: 12.5px; }
.board .spacer { flex: 1; }
.board button { background: transparent; color: var(--bad); border: 0; padding: 4px 8px; font-size: 13px; }
.pill { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.stats { display: flex; gap: 26px; flex-wrap: wrap; }
.stat .n { font-size: 22px; font-weight: 650; }
.stat .l { color: var(--muted); font-size: 12.5px; }
.preview { margin-top: 16px; font-size: 13.5px; }
.preview ul { list-style: none; margin: 8px 0 0; padding: 0; max-height: 220px; overflow: auto; }
.preview li { padding: 5px 0; border-bottom: 1px solid var(--line); color: var(--muted); }
.preview li b { color: var(--text); font-weight: 500; }
.problems { margin-top: 12px; border-left: 2px solid var(--bad); padding-left: 12px; font-size: 13px; }
.problems div { color: var(--bad); }
code { background: #0d1016; padding: 2px 6px; border-radius: 5px; font-size: 12.5px; color: var(--muted); }
footer { color: var(--muted); font-size: 12.5px; padding: 0 28px 40px; max-width: 900px; margin: 0 auto; }
`;

const SCRIPT = String.raw`
const token = new URLSearchParams(location.search).get('token') || '';
const $ = (id) => document.getElementById(id);

// Everything from the server is treated as text, never markup: job titles and
// company names are third-party content.
function text(value) { return document.createTextNode(String(value ?? '')); }
function setText(el, value) { el.textContent = String(value ?? ''); }

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-roleeye-token': token, ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, payload };
}

let state = { criteria: null, sources: null };

function listValue(id) {
  return $(id).value.split(',').map((s) => s.trim()).filter(Boolean);
}

function renderBoards() {
  const host = $('boards');
  host.replaceChildren();

  (state.sources.sources || []).forEach((source, index) => {
    const row = document.createElement('div');
    row.className = 'board';

    const name = document.createElement('span');
    name.className = 'name';
    setText(name, source.company);

    const meta = document.createElement('span');
    meta.className = 'meta';
    setText(meta, source.type + ' · ' + (source.board || source.site || source.url || ''));

    const mode = document.createElement('span');
    mode.className = 'pill';
    setText(mode, source.capture_mode || state.sources.discovery.capture_mode);

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const remove = document.createElement('button');
    setText(remove, 'remove');
    remove.onclick = () => { state.sources.sources.splice(index, 1); renderBoards(); };

    row.append(name, meta, mode, spacer, remove);
    host.append(row);
  });

  if (!(state.sources.sources || []).length) {
    const empty = document.createElement('div');
    empty.className = 'status';
    setText(empty, 'No boards yet. Paste a careers URL above.');
    host.append(empty);
  }
}

async function addBoard() {
  const entry = $('boardEntry').value.trim();
  if (!entry) return;

  const status = $('boardStatus');
  status.className = 'status';
  setText(status, 'Checking…');

  const { payload } = await api('/api/board-check', { method: 'POST', body: JSON.stringify({ entry }) });

  if (!payload.ok) {
    status.className = 'status bad';
    setText(status, payload.reason || 'Could not verify that board.');
    return;
  }

  const company = $('boardCompany').value.trim() || payload.token;
  const source = {
    name: (company + '-' + payload.type).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    type: payload.type,
    enabled: true,
    company,
    ...(payload.type === 'lever' ? { site: payload.token } : { board: payload.token }),
  };

  state.sources.sources = (state.sources.sources || []).filter((s) => s.name !== source.name);
  state.sources.sources.push(source);

  status.className = 'status ok';
  setText(status, 'Added ' + company + ' · ' + payload.openRoles + ' open roles right now.');
  $('boardEntry').value = '';
  $('boardCompany').value = '';
  renderBoards();
}

function collect() {
  const sources = structuredClone(state.sources);
  sources.discovery.capture_mode = $('captureMode').value;
  sources.discovery.scope = {
    ...sources.discovery.scope,
    titles: { include: listValue('titlesInclude'), exclude: listValue('titlesExclude'), patterns: [] },
    levels: { include: listValue('levelsInclude'), exclude: listValue('levelsExclude') },
    locations: {
      countries: listValue('countries'),
      metros: listValue('metros'),
      remote_only: $('remoteOnly').checked,
      exclude: [],
    },
    ...(Number($('postedWithin').value) > 0 ? { posted_within_days: Number($('postedWithin').value) } : {}),
  };

  const criteria = structuredClone(state.criteria);
  criteria.hard_filters = {
    ...criteria.hard_filters,
    countries: listValue('countries'),
    relocation: { reject_if_required: $('rejectRelocation').checked },
    on_unknown: { salary: $('unknownSalary').value, country: 'flag' },
  };

  const floor = Number($('salaryFloor').value);
  if (floor > 0) criteria.hard_filters.minimum_base_salary = { amount: floor, currency: 'USD' };
  else delete criteria.hard_filters.minimum_base_salary;

  criteria.preferences = {
    ...criteria.preferences,
    application_system: { deny: listValue('denySystems') },
  };
  criteria.screening = { ...criteria.screening, enabled: $('screeningEnabled').checked };

  return { sources, criteria };
}

function showProblems(host, problems) {
  host.replaceChildren();
  (problems || []).forEach((problem) => {
    const line = document.createElement('div');
    setText(line, problem.path + ': ' + problem.message);
    host.append(line);
  });
}

async function save() {
  const { sources, criteria } = collect();
  const status = $('saveStatus');
  status.className = 'status';
  setText(status, 'Saving…');

  const a = await api('/api/config/sources', { method: 'PUT', body: JSON.stringify(sources) });
  const b = await api('/api/config/criteria', { method: 'PUT', body: JSON.stringify(criteria) });

  showProblems($('problems'), [...(a.payload.problems || []), ...(b.payload.problems || [])]);

  if (a.ok && b.ok) {
    state.sources = sources;
    state.criteria = criteria;
    status.className = 'status ok';
    setText(status, 'Saved. Run roleeye scan, or wait for the scheduled run.');
  } else {
    status.className = 'status bad';
    setText(status, 'Nothing was written: fix the problems below.');
  }
}

async function preview() {
  const { sources } = collect();
  const { payload } = await api('/api/scope-preview', { method: 'POST', body: JSON.stringify({ sources }) });

  const host = $('previewOut');
  host.replaceChildren();

  if (payload.error) {
    const line = document.createElement('div');
    line.className = 'status bad';
    setText(line, payload.error);
    host.append(line);
    return;
  }

  const summary = document.createElement('div');
  setText(summary, payload.kept + ' kept, ' + payload.dropped + ' dropped, of ' + payload.evaluated + ' stored roles.');
  host.append(summary);

  const list = document.createElement('ul');
  (payload.droppedSample || []).forEach((job) => {
    const item = document.createElement('li');
    const b = document.createElement('b');
    setText(b, job.company + ' — ' + job.title);
    item.append(b, text('  ' + job.reason));
    list.append(item);
  });
  host.append(list);
}

async function load() {
  const { payload } = await api('/api/config');
  state.criteria = payload.criteria;
  state.sources = payload.sources;

  const scope = state.sources.discovery.scope || {};
  $('captureMode').value = state.sources.discovery.capture_mode;
  $('titlesInclude').value = (scope.titles?.include || []).join(', ');
  $('titlesExclude').value = (scope.titles?.exclude || []).join(', ');
  $('levelsInclude').value = (scope.levels?.include || []).join(', ');
  $('levelsExclude').value = (scope.levels?.exclude || []).join(', ');
  $('countries').value = (scope.locations?.countries || state.criteria.hard_filters.countries || []).join(', ');
  $('metros').value = (scope.locations?.metros || []).join(', ');
  $('remoteOnly').checked = Boolean(scope.locations?.remote_only);
  $('postedWithin').value = scope.posted_within_days || '';

  $('salaryFloor').value = state.criteria.hard_filters.minimum_base_salary?.amount || '';
  $('rejectRelocation').checked = Boolean(state.criteria.hard_filters.relocation?.reject_if_required);
  $('unknownSalary').value = state.criteria.hard_filters.on_unknown?.salary || 'flag';
  $('denySystems').value = (state.criteria.preferences?.application_system?.deny || []).join(', ');
  $('screeningEnabled').checked = state.criteria.screening?.enabled !== false;

  setText($('paths'), payload.locations.criteria + '  ·  ' + payload.locations.sources);
  renderBoards();

  const status = await api('/api/status');
  setText($('statJobs'), status.payload.jobs);
  setText($('statSources'), status.payload.sources.enabled);
  setText($('statCompanies'), status.payload.companies);
}

$('addBoard').onclick = addBoard;
$('save').onclick = save;
$('preview').onclick = preview;
$('boardEntry').addEventListener('keydown', (e) => { if (e.key === 'Enter') addBoard(); });
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
  <h1>RoleEye</h1>
  <span class="sub">local configuration &middot; nothing leaves this machine</span>
</header>

<main>
  <section>
    <h2>Where it is looking</h2>
    <p class="hint">Paste a careers page URL. RoleEye checks the board is reachable before adding it.</p>
    <div class="row">
      <div>
        <label for="boardEntry">Careers URL or board token</label>
        <input id="boardEntry" placeholder="https://boards.greenhouse.io/airtable" spellcheck="false">
      </div>
      <div>
        <label for="boardCompany">Company name (optional)</label>
        <input id="boardCompany" placeholder="Airtable">
      </div>
    </div>
    <div class="actions">
      <button id="addBoard" class="secondary">Check and add</button>
      <span id="boardStatus" class="status"></span>
    </div>
    <div class="boards" id="boards"></div>
  </section>

  <section>
    <h2>What counts as relevant</h2>
    <p class="hint">A board holds hundreds of roles. This decides which ones are worth your attention.</p>
    <div class="row">
      <div>
        <label for="titlesInclude">Titles to include</label>
        <input id="titlesInclude" placeholder="engineer, architect">
      </div>
      <div>
        <label for="titlesExclude">Titles to exclude</label>
        <input id="titlesExclude" placeholder="intern, manager, director">
      </div>
    </div>
    <div class="row">
      <div>
        <label for="levelsInclude">Levels to include</label>
        <input id="levelsInclude" placeholder="senior, staff, principal">
      </div>
      <div>
        <label for="levelsExclude">Levels to exclude</label>
        <input id="levelsExclude" placeholder="intern, junior">
      </div>
    </div>
    <div class="row">
      <div>
        <label for="countries">Countries</label>
        <input id="countries" placeholder="US">
      </div>
      <div>
        <label for="metros">Metros (optional)</label>
        <input id="metros" placeholder="seattle, new york">
      </div>
    </div>
    <div class="row">
      <div>
        <label for="postedWithin">Posted within (days)</label>
        <input id="postedWithin" type="number" min="1" placeholder="60">
      </div>
      <div>
        <label for="captureMode">Capture mode</label>
        <select id="captureMode">
          <option value="scoped">scoped — store only relevant roles</option>
          <option value="full">full — store everything, flag relevance</option>
          <option value="history">history — metadata only, market record</option>
        </select>
      </div>
    </div>
    <div class="check"><input type="checkbox" id="remoteOnly"><label for="remoteOnly">Remote roles only</label></div>
    <div class="actions">
      <button id="preview" class="secondary">Preview against stored roles</button>
    </div>
    <div class="preview" id="previewOut"></div>
  </section>

  <section>
    <h2>Your rules</h2>
    <p class="hint">Applied deterministically before anything is evaluated. A rejection always names the rule.</p>
    <div class="row">
      <div>
        <label for="salaryFloor">Minimum base salary (USD, blank to skip)</label>
        <input id="salaryFloor" type="number" min="0" placeholder="200000">
      </div>
      <div>
        <label for="unknownSalary">When a posting states no salary</label>
        <select id="unknownSalary">
          <option value="flag">flag it, keep the role</option>
          <option value="allow">accept silently</option>
          <option value="reject">reject the role</option>
        </select>
      </div>
    </div>
    <label for="denySystems">Application systems to refuse</label>
    <input id="denySystems" placeholder="workday">
    <div class="check"><input type="checkbox" id="rejectRelocation"><label for="rejectRelocation">Reject roles that require relocation</label></div>
    <div class="check"><input type="checkbox" id="screeningEnabled"><label for="screeningEnabled">Screen postings for ghost jobs and scams</label></div>
  </section>

  <section>
    <h2>Local record</h2>
    <div class="stats">
      <div class="stat"><div class="n" id="statJobs">0</div><div class="l">roles stored</div></div>
      <div class="stat"><div class="n" id="statSources">0</div><div class="l">sources enabled</div></div>
      <div class="stat"><div class="n" id="statCompanies">0</div><div class="l">companies</div></div>
    </div>
    <div class="actions">
      <button id="save">Save configuration</button>
      <span id="saveStatus" class="status"></span>
    </div>
    <div class="problems" id="problems"></div>
  </section>
</main>

<footer>
  Writes <code id="paths"></code>. The CLI reads the same files, validated by the same rules.
  Nothing here calls a model or sends anything off this machine.
</footer>

<script>${SCRIPT}</script>
</body>
</html>`;
}
