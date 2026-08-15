/**
 * Phase 6.5: the review views.
 *
 * Kept in its own module because the configuration page is already long, and
 * because these views answer a different question. Setup asks "what should I
 * watch?"; these ask "what did it find, what did I do, and is any of it
 * working?".
 *
 * Two rules govern every line of the script below:
 *
 * - **Nothing is ever built with `innerHTML`.** Every value that came from a
 *   posting is placed with `textContent`, so markup in a job description is
 *   text on the page and never nodes in the document. The server bounds and
 *   flattens the same strings; neither layer is trusted to be the only one.
 * - **Apply records; it does not apply.** The button writes to the local
 *   database and opens the employer's page in a new tab. It cannot fill a form,
 *   and the label says what it does.
 */

export const REVIEW_STYLES = String.raw`
nav.views { display:flex; gap:6px; margin-left:auto; }
nav.views button {
  border:1px solid transparent; background:none; color:var(--muted); cursor:pointer;
  padding:7px 14px; border-radius:8px; font:inherit; font-size:13px; letter-spacing:.01em;
}
nav.views button:hover { color:var(--text); }
nav.views button[aria-pressed="true"] { color:var(--text); background:var(--surface); border-color:var(--line); }
.view { display:block; }
.card {
  border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin-bottom:14px;
  background:var(--surface);
}
.card .top { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.card .top b { font-size:15px; }
.card .top .byline { color:var(--muted); font-size:13px; }
.card .why { margin:10px 0 0; font-size:13.5px; line-height:1.5; }
.card ul { margin:8px 0 0; padding-left:18px; font-size:13px; color:var(--muted); line-height:1.55; }
.card .acts { display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; align-items:center; }
.score { font-variant-numeric:tabular-nums; font-weight:600; margin-left:auto; }
.timeline { margin:10px 0 0; padding:0; list-style:none; font-size:13px; color:var(--muted); }
.timeline li { padding:3px 0 3px 14px; border-left:2px solid var(--line); margin-left:3px; }
.bars { display:grid; gap:6px; margin-top:6px; }
.bar { display:grid; grid-template-columns:130px 52px 1fr; align-items:center; gap:10px; font-size:13px; }
.bar .fill { height:9px; border-radius:5px; background:var(--accent); min-width:2px; }
.bar .n { text-align:right; font-variant-numeric:tabular-nums; color:var(--text); }
table.grid { width:100%; border-collapse:collapse; font-size:13px; }
table.grid th { text-align:left; color:var(--muted); font-weight:500; padding:6px 8px; border-bottom:1px solid var(--line); }
table.grid td { padding:6px 8px; border-bottom:1px solid var(--line); }
.empty { color:var(--muted); font-size:13.5px; line-height:1.6; }
`;

export const REVIEW_MARKUP = String.raw`
<div class="shell" id="viewReview">
  <main>
    <section style="--i:0">
      <h2>Review queue</h2>
      <p class="hint">What the evaluation put forward, with what it worried about. Deciding here records what you did — it never submits anything.</p>
      <div class="rowline">
        <span class="count" id="queueCount"></span>
        <button class="ghost" id="queueRefresh" type="button">Refresh</button>
      </div>
      <div id="queue"></div>
    </section>
  </main>
  <aside>
    <div class="panel">
      <h3>How this works</h3>
      <div class="empty">
        <b>Apply</b> records that you applied and opens the posting in a new tab.
        <b>Pass</b> records that you decided not to. Both are kept, including when
        you disagree with the advice — that disagreement is the most useful thing
        this tool can learn from you.
      </div>
    </div>
    <div class="panel">
      <h3>Detail</h3>
      <div id="detail" class="empty">Select a role to see its history, sources, and screening signals.</div>
      <div class="label">Note</div>
      <input type="text" id="noteText" placeholder="Who you spoke to, what was said">
      <div><button class="ghost" id="noteAdd" type="button" style="margin-top:8px">Add a note</button></div>
    </div>
  </aside>
</div>

<div class="shell" id="viewPipeline">
  <main>
    <section style="--i:0">
      <h2>Applications</h2>
      <p class="hint">Status history is append-only. Correcting a status adds to the record rather than replacing it.</p>
      <div class="rowline">
        <span class="count" id="pipelineCount"></span>
        <button class="ghost" id="pipelineRefresh" type="button">Refresh</button>
      </div>
      <div id="pipeline"></div>
    </section>
  </main>
  <aside>
    <div class="panel">
      <h3>Open</h3>
      <div class="metrics">
        <div class="metric"><div class="n" id="pipeOpen">0</div><div class="l">in flight</div></div>
        <div class="metric"><div class="n" id="pipeWaiting">0</div><div class="l">awaiting a decision</div></div>
      </div>
    </div>
    <div class="panel">
      <h3>History</h3>
      <p class="hint" style="margin-top:0">Every role ever seen, including the closed ones.</p>
      <input type="text" id="historyQuery" placeholder="Search titles and descriptions">
      <div><button class="ghost" id="historyGo" type="button" style="margin-top:8px">Search</button></div>
      <div id="history" style="margin-top:10px"></div>
    </div>
  </aside>
</div>

<div class="shell" id="viewReports">
  <main>
    <section style="--i:0">
      <h2>Funnel</h2>
      <p class="hint">Computed from the records every time this loads. Nothing here is a stored number.</p>
      <div class="bars" id="funnel"></div>
      <div class="status" id="rates"></div>
    </section>

    <section style="--i:1">
      <h2>Where the time went</h2>
      <p class="hint">Applications only. Segmenting what was discovered would describe the internet, not you.</p>
      <div class="chips" id="dimensions"></div>
      <div id="segments"></div>
    </section>
  </main>
  <aside>
    <div class="panel">
      <h3>Model spend</h3>
      <div class="metrics">
        <div class="metric"><div class="n" id="spendMonth">$0</div><div class="l">this month</div></div>
      </div>
      <div id="spend" class="empty" style="margin-top:10px"></div>
    </div>
  </aside>
</div>
`;

export const REVIEW_SCRIPT = String.raw`
const review = { view: 'setup', queue: [], pipeline: null, reports: null, dimension: 'company', detailJobId: null };

const VIEWS = [
  ['setup', 'Setup', 'viewSetup'],
  ['review', 'Review', 'viewReview'],
  ['pipeline', 'Applications', 'viewPipeline'],
  ['reports', 'Reports', 'viewReports'],
];

function showView(name) {
  review.view = name;
  for (const [id, , element] of VIEWS) {
    const host = $(element);
    if (host && host.style) host.style.display = id === name ? '' : 'none';
  }
  for (const [id] of VIEWS) {
    const button = $('nav-' + id);
    if (button && button.setAttribute) button.setAttribute('aria-pressed', String(id === name));
  }
  if (name === 'review') loadQueue();
  if (name === 'pipeline') loadPipeline();
  if (name === 'reports') loadReports();
}

function line(text, className) {
  const div = document.createElement('div');
  if (className) div.className = className;
  div.textContent = text;
  return div;
}

/**
 * A link the page is willing to follow.
 *
 * The server already refuses anything that is not http or https, and
 * canonicalisation upgrades every link it keeps to https — so https is what the
 * page will ever legitimately be handed. Accepting http here would only widen
 * the sink if the server's behaviour changed, which is the opposite of what a
 * second layer is for. 'javascript:' in a link the user clicks is script
 * execution, and 'noopener' has nothing to do with it.
 */
function openable(url) {
  if (typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  return trimmed.toLowerCase().indexOf('https://') === 0 ? trimmed : undefined;
}

function bullets(host, label, items) {
  if (!items || items.length === 0) return;
  host.append(line(label, 'label'));
  const list = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.append(li);
  }
  host.append(list);
}

function button(label, className, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.onclick = onClick;
  return element;
}

async function loadQueue() {
  const result = await api('/api/queue');
  if (!result.ok) {
    $('queue').replaceChildren(line(reasonOf(result), 'empty'));
    $('queueCount').textContent = '';
    return;
  }

  review.queue = result.payload.items || [];

  const host = $('queue');
  host.replaceChildren();
  $('queueCount').textContent = review.queue.length + ' role(s) awaiting your call';

  if (review.queue.length === 0) {
    host.append(line('Nothing evaluated yet. Run roleeye scan, then roleeye screen, then roleeye evaluate.', 'empty'));
    return;
  }

  for (const item of review.queue) {
    const card = document.createElement('div');
    card.className = 'card';

    const top = document.createElement('div');
    top.className = 'top';
    const title = document.createElement('b');
    title.textContent = item.title || '(untitled)';
    const company = document.createElement('span');
    company.className = 'byline';
    company.textContent = item.company || '';
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = item.decision + ' ' + Math.round(item.score || 0);
    top.append(title, company, score);
    card.append(top);

    const facts = [item.location, item.level, item.firstSeenAt ? 'seen ' + item.firstSeenAt.slice(0, 10) : ''].filter(Boolean);
    card.append(line(facts.join('  ·  '), 'hint'));

    if (item.authenticity) {
      const signals = [
        'freshness ' + item.authenticity.freshness,
        'intent ' + item.authenticity.hiringIntent,
        'fraud risk ' + item.authenticity.fraudRisk,
        'provenance ' + item.authenticity.provenance,
      ];
      card.append(line(signals.join('  ·  '), 'hint'));
    }

    if (item.headline) {
      const why = document.createElement('p');
      why.className = 'why';
      why.textContent = item.headline;
      card.append(why);
    }

    bullets(card, 'Concerns', item.concerns);
    bullets(card, 'Worth verifying', item.verify);

    const acts = document.createElement('div');
    acts.className = 'acts';

    if (item.decided) {
      acts.append(line(item.decided.kind === 'applied' ? 'Applied · ' + item.decided.status : 'Passed', 'count'));
    } else {
      acts.append(button('Record that I applied', 'primary', () => decide(item, 'apply')));
      acts.append(button('Pass', 'ghost', () => decide(item, 'skip')));
    }

    acts.append(button('Detail', 'ghost', () => loadDetail(item.jobId)));
    card.append(acts);

    if (openable(item.url)) card.append(line(item.url, 'hint'));

    host.append(card);
  }
}

async function decide(item, action) {
  const { ok, payload } = await api('/api/decide', {
    method: 'POST',
    body: JSON.stringify({ jobId: item.jobId, action: action }),
  });

  const alert = $('alert');
  if (!ok) {
    alert.className = 'alert bad';
    alert.textContent = reasonOf({ ok: false, payload: payload });
    return;
  }

  // The URL comes back from the server, which took it from the posting rather
  // than from anything this page sent it.
  const url = openable(payload.url);

  alert.className = 'alert ok';
  alert.textContent =
    action === 'apply'
      ? 'Recorded. Nothing was submitted for you' + (url ? ' — the posting is open in a new tab.' : '.')
      : 'Recorded that you passed. That is feedback, not a deletion.';

  if (action === 'apply' && url && typeof open === 'function') open(url, '_blank', 'noopener');

  loadQueue();
}

async function loadDetail(jobId) {
  const result = await api('/api/job?id=' + encodeURIComponent(jobId));
  const payload = result.payload || {};
  const host = $('detail');
  host.replaceChildren();
  review.detailJobId = jobId;

  if (!result.ok && result.reachable === false) {
    host.append(line(reasonOf(result), 'empty'));
    return;
  }

  if (!payload.job) {
    host.append(line('That role is no longer in the record.', 'empty'));
    return;
  }

  host.append(line(payload.job.title || '', 'label'));
  host.append(line(payload.job.company || '', 'hint'));

  for (const posting of payload.postings || []) {
    host.append(line(posting.sourceType + ' · seen ' + posting.firstSeenAt.slice(0, 10) + (posting.closedAt ? ' · closed' : ''), 'hint'));
  }

  if (payload.snapshots && payload.snapshots.length > 0) {
    host.append(line(payload.snapshots.length + ' description revision(s) kept', 'hint'));
  }

  if (payload.screening) {
    host.append(line(payload.screening.eligible ? 'Passed your rules' : 'Blocked by your rules', 'label'));
    bullets(host, 'Why', payload.screening.rejections || []);
  }

  if (payload.application) {
    host.append(line('Application', 'label'));
    const list = document.createElement('ul');
    list.className = 'timeline';
    for (const event of payload.application.history || []) {
      const li = document.createElement('li');
      li.textContent = event.at.slice(0, 10) + '  ' + (event.from || 'none') + ' to ' + event.to + (event.note ? ' — ' + event.note : '');
      list.append(li);
    }
    host.append(list);
  }

  for (const note of payload.notes || []) {
    host.append(line(note.at.slice(0, 10) + '  ' + note.text, 'hint'));
  }
}

/**
 * Notes are what a person remembers and a scraper cannot: who the recruiter
 * was, what the salary conversation actually said. They belong beside the role,
 * and until now the API accepted them and nothing could send one.
 */
async function addNote() {
  const field = $('noteText');
  const text = (field.value || '').trim();
  const alert = $('alert');

  if (!review.detailJobId) {
    alert.className = 'alert bad';
    alert.textContent = 'Open a role first, then add the note to it.';
    return;
  }

  if (text.length === 0) {
    alert.className = 'alert bad';
    alert.textContent = 'The note is empty.';
    return;
  }

  const result = await api('/api/note', {
    method: 'POST',
    body: JSON.stringify({ jobId: review.detailJobId, text: text }),
  });

  alert.className = result.ok ? 'alert ok' : 'alert bad';
  alert.textContent = result.ok ? 'Noted.' : reasonOf(result);

  if (result.ok) {
    field.value = '';
    loadDetail(review.detailJobId);
  }
}

async function loadPipeline() {
  const result = await api('/api/pipeline');
  if (!result.ok) {
    $('pipeline').replaceChildren(line(reasonOf(result), 'empty'));
    $('pipelineCount').textContent = '';
    return;
  }

  const payload = result.payload;
  review.pipeline = payload;

  $('pipeOpen').textContent = String((payload.summary && payload.summary.open) || 0);
  $('pipeWaiting').textContent = String((payload.summary && payload.summary.awaitingDecision) || 0);

  const host = $('pipeline');
  host.replaceChildren();

  const applications = payload.applications || [];
  $('pipelineCount').textContent = applications.length + ' application(s)';

  if (applications.length === 0) {
    host.append(line('Nothing recorded yet. Decide on a role in the review queue and it appears here.', 'empty'));
    return;
  }

  for (const application of applications) {
    const card = document.createElement('div');
    card.className = 'card';

    const top = document.createElement('div');
    top.className = 'top';
    const title = document.createElement('b');
    title.textContent = application.title || '(untitled)';
    const company = document.createElement('span');
    company.className = 'byline';
    company.textContent = application.company || '';
    const status = document.createElement('span');
    status.className = 'score';
    status.textContent = application.status;
    top.append(title, company, status);
    card.append(top);

    card.append(line('applied ' + String(application.appliedAt).slice(0, 10) +
      (application.archetypeId ? '  ·  resume ' + application.archetypeId : '') +
      (application.decisionAtApply ? '  ·  advised ' + application.decisionAtApply : ''), 'hint'));

    const list = document.createElement('ul');
    list.className = 'timeline';
    for (const event of application.history || []) {
      const li = document.createElement('li');
      li.textContent = String(event.at).slice(0, 10) + '  ' + (event.from || 'none') + ' to ' + event.to + (event.note ? ' — ' + event.note : '');
      list.append(li);
    }
    card.append(list);

    const acts = document.createElement('div');
    acts.className = 'acts';
    for (const next of payload.statuses || []) {
      if (next === application.status) continue;
      acts.append(button(next.toLowerCase().replace('_', ' '), 'ghost', () => advance(application.jobId, next)));
    }
    card.append(acts);

    host.append(card);
  }
}

async function advance(jobId, status) {
  const result = await api('/api/pipeline/status', {
    method: 'POST',
    body: JSON.stringify({ jobId: jobId, status: status }),
  });

  const alert = $('alert');
  alert.className = result.ok ? 'alert ok' : 'alert bad';
  alert.textContent = result.ok ? 'Recorded. The previous state is still on record.' : reasonOf(result);
  if (result.ok) loadPipeline();
}

async function loadHistory() {
  const query = $('historyQuery').value || '';
  const result = await api('/api/history?q=' + encodeURIComponent(query));

  const host = $('history');
  host.replaceChildren();

  if (!result.ok) {
    host.append(line(reasonOf(result), 'empty'));
    return;
  }

  const hits = result.payload.hits || [];
  if (hits.length === 0) {
    host.append(line('Nothing matched. Every word has to appear.', 'empty'));
    return;
  }

  for (const hit of hits) {
    const row = document.createElement('div');
    row.className = 'hint';
    row.textContent = (hit.company ? hit.company + ' — ' : '') + hit.title;
    row.onclick = () => loadDetail(hit.jobId);
    host.append(row);
  }
}

const STAGE_LABELS = {
  discovered: 'discovered', in_scope: 'in scope', screened: 'screened', eligible: 'eligible',
  evaluated: 'evaluated', recommended: 'recommended', applied: 'applied',
  recruiter_screen: 'recruiter screen', interviewing: 'interviewing', final: 'final round', offer: 'offer',
};

const RATE_LABELS = {
  recommendationRate: 'recommended of evaluated',
  applyRate: 'applied of recommended',
  screenRate: 'recruiter screens per application',
  interviewRate: 'interviews per application',
  offerRate: 'offers per application',
};

async function loadReports() {
  const result = await api('/api/reports?segment=' + encodeURIComponent(review.dimension));
  if (!result.ok) {
    $('funnel').replaceChildren();
    $('rates').textContent = reasonOf(result);
    return;
  }

  const payload = result.payload;
  review.reports = payload;

  const counts = (payload.funnel && payload.funnel.counts) || {};
  const widest = Math.max.apply(null, Object.keys(counts).map((key) => counts[key]).concat([1]));

  const host = $('funnel');
  host.replaceChildren();
  for (const stage of Object.keys(counts)) {
    const row = document.createElement('div');
    row.className = 'bar';
    row.append(line(STAGE_LABELS[stage] || stage, ''), line(String(counts[stage]), 'n'));
    const track = document.createElement('div');
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = Math.round((counts[stage] / widest) * 100) + '%';
    track.append(fill);
    row.append(track);
    host.append(row);
  }

  const rates = (payload.funnel && payload.funnel.rates) || {};
  const stated = Object.keys(rates).filter((key) => rates[key] !== null && rates[key] !== undefined);
  $('rates').textContent = stated.length === 0
    ? 'No rates yet: a rate with no denominator is unknown, not zero.'
    : stated.map((key) => (RATE_LABELS[key] || key) + ' ' + Math.round(rates[key] * 100) + '%').join('   ·   ');

  const dimensions = $('dimensions');
  dimensions.replaceChildren();
  for (const dimension of payload.dimensions || []) {
    dimensions.append(chip(dimension.replace('_', ' '), '', dimension === review.dimension, () => {
      review.dimension = dimension;
      loadReports();
    }));
  }

  const segments = $('segments');
  segments.replaceChildren();

  if ((payload.segments || []).length === 0) {
    segments.append(line('Nothing applied to yet. Segments describe outcomes, not postings.', 'empty'));
  } else {
    const table = document.createElement('table');
    table.className = 'grid';
    const head = document.createElement('tr');
    for (const heading of ['segment', 'applied', 'screens', 'interviews', 'offers']) {
      const th = document.createElement('th');
      th.textContent = heading;
      head.append(th);
    }
    table.append(head);

    for (const row of payload.segments) {
      const tr = document.createElement('tr');
      for (const value of [row.segment, row.applications, row.screens, row.interviews, row.offers]) {
        const td = document.createElement('td');
        td.textContent = String(value);
        tr.append(td);
      }
      table.append(tr);
    }
    segments.append(table);
  }

  const spend = payload.spend || { byStage: [] };
  $('spendMonth').textContent = '$' + Number(spend.monthToDate || 0).toFixed(2);

  const spendHost = $('spend');
  spendHost.replaceChildren();
  if ((spend.byStage || []).length === 0) {
    spendHost.append(line('Nothing spent. Discovery and screening never call a model.', 'empty'));
  } else {
    for (const entry of spend.byStage) {
      spendHost.append(line(entry.stage + '  ' + entry.calls + ' call(s)  $' + Number(entry.estimatedCostUsd || 0).toFixed(4), 'hint'));
    }
  }
}

$('nav-setup').onclick = () => showView('setup');
$('nav-review').onclick = () => showView('review');
$('nav-pipeline').onclick = () => showView('pipeline');
$('nav-reports').onclick = () => showView('reports');
$('queueRefresh').onclick = loadQueue;
$('pipelineRefresh').onclick = loadPipeline;
$('historyGo').onclick = loadHistory;
$('noteAdd').onclick = addNote;
showView('setup');
`;
