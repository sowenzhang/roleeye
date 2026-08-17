/**
 * The run view: start it, watch it, schedule it, and see what it will ask.
 *
 * The portal could configure everything and start nothing. A user who had just
 * spent five minutes picking companies and a model was told to open a terminal
 * and type three commands in the right order — so this view exists to make the
 * thing runnable from the place it is configured.
 *
 * Three panels that belong together because they are all about the *next* run:
 *
 * - **Run now** starts the same pipeline `roleeye run` does, and reports each
 *   step while it happens. A seven-minute evaluation with no output is
 *   indistinguishable from a hang.
 * - **Schedule** answers "when does this happen on its own?", which the page
 *   previously referred to without being able to confirm it existed.
 * - **What gets asked** shows the exact prompts before any money is spent. The
 *   templates are read-only on purpose: the fence separating instructions from
 *   attacker-written posting text is a security control, not a preference. What
 *   the user edits is what the prompt says about *them*.
 *
 * Same two rules as every other view: nothing is built with `innerHTML`, and
 * nothing here decides anything the server does not already decide.
 */

export const RUN_STYLES = String.raw`
.runbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:18px; }
.runbar button.primary { width:auto; min-width:170px; }

.prog { display:grid; gap:10px; margin-top:18px; }
.step { display:grid; grid-template-columns:104px 1fr 62px; align-items:center; gap:12px; font-size:13px; }
.step .name { color:var(--muted); text-transform:uppercase; letter-spacing:.06em; font-size:11px; }
.step .track { height:8px; border-radius:5px; background:var(--surface-2); border:1px solid var(--line); overflow:hidden; }
.step .fill { height:100%; width:0; background:var(--faint); transition:width .3s var(--ease), background .3s var(--ease); }
.step .n { text-align:right; font-variant-numeric:tabular-nums; color:var(--faint); font-size:12px; }
.step[data-state="running"] .fill { background:var(--accent); }
.step[data-state="running"] .name { color:var(--accent); }
.step[data-state="done"] .fill { background:#1d6b4f; width:100%; }
.step[data-state="failed"] .fill { background:var(--danger); width:100%; }
.step[data-state="skipped"] .n { color:var(--line-strong); }
.step .say { grid-column:1 / -1; margin:-4px 0 0 116px; color:var(--faint); font-size:12px; }

/* Indeterminate: a stage that is working but cannot yet say how much of it is left. */
.step[data-state="running"][data-indeterminate="1"] .fill {
  width:100%;
  background:linear-gradient(90deg, var(--surface-2) 20%, var(--accent) 50%, var(--surface-2) 80%);
  background-size:220% 100%; animation:sweep 1.5s linear infinite;
}
@keyframes sweep { 0% { background-position:120% 0; } 100% { background-position:-120% 0; } }

.log {
  margin-top:16px; max-height:260px; overflow:auto; border:1px solid var(--line);
  border-radius:10px; background:var(--bg); padding:10px 12px;
  font:12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.log div { display:flex; gap:10px; padding:1px 0; }
.log .t { color:var(--line-strong); flex:none; font-variant-numeric:tabular-nums; }
.log .m { color:var(--muted); min-width:0; overflow-wrap:anywhere; }
.log .m.bad { color:var(--danger); }
.log .m.good { color:var(--accent); }

.tags { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:9px; }
.tags:empty { display:none; }
.tagx {
  display:inline-flex; align-items:center; gap:7px; border:1px solid var(--line-strong);
  background:var(--surface); border-radius:999px; padding:5px 8px 5px 13px; font-size:13px;
}
.tagx button {
  background:none; border:0; color:var(--faint); cursor:pointer; font:inherit; line-height:1;
  padding:2px 5px; border-radius:50%;
}
.tagx button:hover { color:var(--danger); background:var(--surface-2); }

.weights { display:grid; gap:9px; margin-top:4px; }
.wrow { display:grid; grid-template-columns:150px 1fr 46px; align-items:center; gap:12px; font-size:13px; }
.wrow input[type="range"] { accent-color:var(--accent); width:100%; }
.wrow .v { text-align:right; font-variant-numeric:tabular-nums; color:var(--muted); font-size:12.5px; }
.wrow.rate { grid-template-columns:150px auto 1fr; }
.wrow.rate .v { text-align:left; }

.dots { display:flex; gap:5px; align-items:center; }
.dot {
  width:19px; height:19px; border-radius:50%; padding:0; cursor:pointer;
  border:1px solid var(--line-strong); background:var(--surface-2);
  transition:background .15s var(--ease), border-color .15s var(--ease), transform .1s var(--ease);
}
.dot:hover { border-color:var(--faint); }
.dot:active { transform:scale(0.9); }
.dot[aria-pressed="true"] { background:var(--accent); border-color:var(--accent); }
.dot.zero {
  border-radius:6px; color:var(--faint); font:inherit; font-size:11px; line-height:1;
  margin-right:5px; background:transparent; border-color:transparent;
}
.dot.zero:hover { color:var(--danger); }
.dot.zero[aria-pressed="true"] { background:transparent; border-color:transparent; }
.dot:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

pre.prompt {
  margin:10px 0 0; padding:13px 14px; border:1px solid var(--line); border-radius:10px;
  background:var(--bg); color:var(--muted); max-height:340px; overflow:auto;
  font:12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space:pre-wrap; overflow-wrap:anywhere;
}
.sched { display:flex; gap:8px; align-items:center; margin-top:12px; }
.sched input[type="time"] {
  background:var(--surface-2); border:1px solid var(--line-strong); color:var(--text);
  border-radius:9px; padding:8px 10px; font:inherit; font-size:13px; color-scheme:dark;
}
`;

export const RUN_MARKUP = String.raw`
<div class="shell" id="viewRun">
  <main>
    <section style="--i:0">
      <h2>Run now</h2>
      <p class="hint">The same pass the schedule runs: fetch every source, apply your rules, then assess the roles that survive. Only the last step calls a model or costs anything.</p>

      <div class="label">Steps</div>
      <div class="chips" id="runStages"></div>

      <div class="label">Roles to assess this run</div>
      <div class="scale" id="runLimit"></div>
      <div class="status" id="runEstimate"></div>

      <div class="runbar">
        <button class="primary" id="runStart" type="button">Run now</button>
        <button class="ghost" id="runStop" type="button" disabled>Stop</button>
        <span class="count" id="runState"></span>
      </div>

      <div class="prog" id="runProgress"></div>
      <div class="log" id="runLog"></div>
    </section>

    <section style="--i:1">
      <h2>What gets asked</h2>
      <p class="hint">The exact prompts, before anything is sent. The templates are fixed — the barrier separating your instructions from a posting's text is a safety measure, not a preference. What you write below is what the prompt says about you.</p>

      <div class="label">Work you want more of</div>
      <div class="tags" id="dirPositive"></div>
      <input type="text" id="dirPositiveInput" placeholder="Type a phrase and press Enter — e.g. customer-facing AI product work">

      <div class="label">Work you want less of</div>
      <div class="tags" id="dirNegative"></div>
      <input type="text" id="dirNegativeInput" placeholder="e.g. internal platform, people management">

      <div class="label">What matters to you</div>
      <p class="hint" style="margin:-4px 0 10px">Rate each one. RoleEye turns these into the score's weighting — you never have to make anything add up.</p>
      <div class="weights" id="weights"></div>
      <div class="status" id="weightsTotal"></div>

      <div class="label">Where the verdict lands</div>
      <div class="weights" id="thresholds"></div>

      <div class="runbar">
        <button class="primary" id="guidanceSave" type="button" style="min-width:150px">Save guidance</button>
        <span class="count" id="guidanceStatus"></span>
      </div>
      <div class="problems" id="guidanceProblems"></div>

      <details class="adv" id="promptDetails">
        <summary>Show the exact prompts that would be sent</summary>
        <div class="body" id="promptOut"></div>
      </details>
    </section>
  </main>

  <aside>
    <div class="panel">
      <h3>Scheduled run</h3>
      <div id="scheduleOut" class="empty">Checking...</div>
      <div class="sched">
        <input type="time" id="scheduleAt" value="07:30">
        <button class="ghost" id="scheduleSave" type="button">Schedule daily</button>
      </div>
      <div><button class="ghost" id="scheduleRemove" type="button" style="margin-top:8px">Remove</button></div>
      <div class="status" id="scheduleStatus"></div>
    </div>

    <div class="panel">
      <h3>Last run</h3>
      <div class="metrics">
        <div class="metric"><div class="n" id="runNew">0</div><div class="l">new roles</div></div>
        <div class="metric"><div class="n" id="runEligible">0</div><div class="l">eligible</div></div>
        <div class="metric"><div class="n" id="runApply">0</div><div class="l">worth applying</div></div>
        <div class="metric"><div class="n" id="runSpend">$0</div><div class="l">spent this run</div></div>
      </div>
      <div class="status" id="runFinished"></div>
    </div>

    <div class="panel">
      <h3>What it costs</h3>
      <div class="empty" style="padding:0; border:0; text-align:left" id="costNote">
        Fetching and your rules are free and never leave a model anything to read.
        Only the assessment step spends.
      </div>
    </div>
  </aside>
</div>
`;

export const RUN_SCRIPT = String.raw`
const runView = {
  stages: ['scan', 'screen', 'evaluate'],
  selected: ['scan', 'screen', 'evaluate'],
  limit: 5,
  minutesPerRole: undefined,
  provider: 'none',
  timer: undefined,
  guidance: { direction: { positive: [], negative: [] }, weights: {}, decision_thresholds: {} },
  promptLoaded: false,
};

const STAGE_LABEL = { scan: 'Fetch', screen: 'Filter', evaluate: 'Assess' };
const STAGE_SUB = { scan: 'read every source', screen: 'apply your rules', evaluate: 'costs money' };
const WEIGHT_LABEL = {
  career_direction: 'Career direction',
  hands_on: 'Hands-on work',
  product_customer: 'Product and customers',
  ai_relevance: 'AI relevance',
  technical_domain: 'Technical domain',
  location: 'Location',
  compensation: 'Compensation',
};

const WEIGHT_ORDER = [
  'career_direction',
  'hands_on',
  'product_customer',
  'ai_relevance',
  'technical_domain',
  'location',
  'compensation',
];

function el(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A pressable chip, local to this view.
 *
 * The setup view's chip builder re-renders the whole configuration page on
 * every click, which is right there and wrong here: pressing "Assess" must not
 * rebuild the company catalog.
 */
function runChip(label, sub, pressed, onClick) {
  const node = el('button', 'chip');
  node.type = 'button';
  node.setAttribute('aria-pressed', String(pressed));
  node.append(tickIcon(), el('span', undefined, label));
  if (sub) node.append(el('span', 'sub', sub));
  node.onclick = onClick;
  return node;
}

function clock(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderRunStages() {
  const host = $('runStages');
  if (!host) return;
  host.replaceChildren();

  runView.stages.forEach((stage) => {
    host.append(
      runChip(STAGE_LABEL[stage] || stage, STAGE_SUB[stage], runView.selected.indexOf(stage) >= 0, () => {
        toggle(runView.selected, stage);
        renderRunStages();
        renderRunEstimate();
      }),
    );
  });
}

function renderRunLimit() {
  const host = $('runLimit');
  if (!host) return;
  host.replaceChildren();

  [1, 3, 5, 10, 20, 40].forEach((value) => {
    host.append(
      runChip(String(value), undefined, runView.limit === value, () => {
        runView.limit = value;
        renderRunLimit();
        renderRunEstimate();
      }),
    );
  });
}

/**
 * How long this will take, before it is started.
 *
 * An agent CLI was measured at minutes per role. Someone who picks forty roles
 * deserves to know that is most of an afternoon before they press the button,
 * not after.
 */
function renderRunEstimate() {
  const host = $('runEstimate');
  if (!host) return;

  if (runView.selected.indexOf('evaluate') < 0) {
    host.className = 'status';
    host.textContent = 'Assessment is off, so this run is free and takes seconds.';
    return;
  }

  if (runView.provider === 'none') {
    host.className = 'status bad';
    host.textContent = 'No reasoning engine is picked yet, so nothing would be assessed. Choose one under Setup.';
    return;
  }

  if (!runView.minutesPerRole) {
    host.className = 'status';
    host.textContent = '';
    return;
  }

  const minutes = runView.minutesPerRole * runView.limit;
  const estimate = minutes >= 60 ? (minutes / 60).toFixed(1) + ' hours' : Math.max(1, Math.round(minutes)) + ' minutes';

  host.className = minutes > 60 ? 'status bad' : 'status';
  host.textContent = 'Roughly ' + estimate + ' at this engine\u2019s measured speed. You can stop it at any point and keep what finished.';
}

function renderProgress(snapshot) {
  const host = $('runProgress');
  if (!host) return;
  host.replaceChildren();

  (snapshot.stages || []).forEach((stage) => {
    const row = el('div', 'step');
    row.setAttribute('data-state', stage.status);

    const known = typeof stage.total === 'number' && stage.total > 0;
    // A stage that is working but cannot yet count its work gets a sweep
    // rather than a bar frozen at zero, which reads as stuck.
    row.setAttribute('data-indeterminate', known ? '0' : '1');

    row.append(el('div', 'name', STAGE_LABEL[stage.stage] || stage.stage));

    const track = el('div', 'track');
    const fill = el('div', 'fill');
    if (known && stage.status === 'running') fill.style.width = Math.round((stage.done / stage.total) * 100) + '%';
    track.append(fill);
    row.append(track);

    row.append(el('div', 'n', known ? stage.done + '/' + stage.total : stage.status === 'pending' ? '' : stage.status));
    if (stage.message) row.append(el('div', 'say', stage.message));

    host.append(row);
  });
}

function renderLog(snapshot) {
  const host = $('runLog');
  if (!host) return;

  const entries = snapshot.log || [];
  if (entries.length === 0) {
    host.replaceChildren(el('div', undefined, 'Nothing has run yet in this session.'));
    return;
  }

  const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
  host.replaceChildren();

  entries.forEach((entry) => {
    const row = el('div');
    row.append(el('span', 't', clock(entry.at)));
    const kind = entry.kind === 'stage-failed' ? ' bad' : entry.kind === 'stage-done' ? ' good' : '';
    row.append(el('span', 'm' + kind, entry.message));
    host.append(row);
  });

  // Follows the tail only while the user is already at it, so reading back
  // through a long run is not yanked away every second.
  if (atBottom) host.scrollTop = host.scrollHeight;
}

function renderRunSummary(snapshot) {
  const result = snapshot.result;
  if (!result) return;

  $('runNew').textContent = result.scan ? result.scan.totals.new : 0;
  $('runEligible').textContent = result.screen ? result.screen.eligible : result.evaluate ? result.evaluate.eligible : 0;
  $('runApply').textContent = result.evaluate ? result.evaluate.apply : 0;
  $('runSpend').textContent = '$' + (result.evaluate ? result.evaluate.scanCostUsd : 0).toFixed(2);

  const finished = $('runFinished');
  const trouble = (result.errors || []).concat(result.warnings || []);

  finished.className = result.status === 'ok' ? 'status ok' : result.status === 'cancelled' ? 'status' : 'status bad';
  finished.textContent =
    result.status === 'ok'
      ? 'Finished at ' + clock(result.finishedAt) + '. Open Review to decide.'
      : result.status === 'cancelled'
        ? 'Stopped at ' + clock(result.finishedAt) + '. Everything already finished is saved.'
        : trouble.map((entry) => entry.stage + ': ' + entry.message).join(' — ');
}

function applyRunState(snapshot) {
  const running = snapshot.running === true;

  $('runStart').disabled = running;
  $('runStop').disabled = !running || snapshot.cancelRequested === true;
  $('runStart').textContent = running ? 'Running...' : 'Run now';

  const label = $('runState');
  const FINISHED = {
    ok: 'finished cleanly',
    warning: 'finished, with something to look at',
    failed: 'failed',
    cancelled: 'stopped',
  };

  label.textContent = running
    ? snapshot.cancelRequested
      ? 'stopping after the current step'
      : 'started ' + clock(snapshot.startedAt)
    : snapshot.status === 'idle'
      ? ''
      : snapshot.status === 'error'
        ? snapshot.error || 'failed to start'
        : FINISHED[snapshot.status] || snapshot.status;

  renderProgress(snapshot);
  renderLog(snapshot);
  renderRunSummary(snapshot);

  if (running) startRunPolling();
  else stopRunPolling();
}

function startRunPolling() {
  if (runView.timer !== undefined) return;
  // One second: the cheapest thing that still feels live. The endpoint reads an
  // in-memory object and never touches the database.
  runView.timer = setInterval(pollRun, 1000);
}

function stopRunPolling() {
  if (runView.timer === undefined) return;
  clearInterval(runView.timer);
  runView.timer = undefined;
}

async function pollRun() {
  const result = await api('/api/run');
  if (!result.ok) {
    stopRunPolling();
    return;
  }
  applyRunState(result.payload);
}

async function startRun() {
  if (runView.selected.length === 0) {
    const label = $('runState');
    label.textContent = 'Pick at least one step.';
    return;
  }

  $('runStart').disabled = true;
  const result = await api('/api/run', {
    method: 'POST',
    body: JSON.stringify({ stages: runView.selected, limit: runView.limit }),
  });

  if (!result.ok) {
    $('runStart').disabled = false;
    $('runState').textContent = reasonOf(result);
    if (result.payload && result.payload.state) applyRunState(result.payload.state);
    return;
  }

  applyRunState(result.payload.state);
  startRunPolling();
}

async function stopRun() {
  $('runStop').disabled = true;
  const result = await api('/api/run/cancel', { method: 'POST' });
  if (result.ok) applyRunState(result.payload.state);
}

function renderTags(hostId, list, onChange) {
  const host = $(hostId);
  if (!host) return;
  host.replaceChildren();

  list.forEach((phrase, index) => {
    const tag = el('span', 'tagx');
    tag.append(el('span', undefined, phrase));

    const remove = el('button', undefined, '\u00d7');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove ' + phrase);
    remove.onclick = () => {
      list.splice(index, 1);
      onChange();
    };

    tag.append(remove);
    host.append(tag);
  });
}

function renderGuidance() {
  const direction = runView.guidance.direction;
  renderTags('dirPositive', direction.positive, renderGuidance);
  renderTags('dirNegative', direction.negative, renderGuidance);

  const host = $('weights');
  host.replaceChildren();

  const importance = runView.guidance.importance || {};
  const labels = runView.guidance.importanceLabels || ['Ignore', 'Barely', 'Somewhat', 'Matters', 'Important', 'Critical'];

  WEIGHT_ORDER.forEach((key) => {
    if (importance[key] === undefined) return;
    const rating = importance[key];

    const row = el('div', 'wrow rate');
    row.append(el('span', undefined, WEIGHT_LABEL[key] || key));

    // Five dots rather than a slider: the question is "how much does this
    // matter", which has about five useful answers, not a hundred.
    const scale = el('div', 'dots');

    // The leading control is "ignore this entirely", not a sixth level, so it
    // is never shown as selected — it is an action, and the label says what
    // happened.
    const clear = el('button', 'dot zero', '\u00d7');
    clear.type = 'button';
    clear.setAttribute('aria-label', WEIGHT_LABEL[key] + ': ignore this entirely');
    clear.onclick = () => {
      runView.guidance.importance[key] = 0;
      renderGuidance();
    };
    scale.append(clear);

    for (let step = 1; step <= 5; step += 1) {
      const dot = el('button', 'dot');
      dot.type = 'button';
      dot.setAttribute('aria-pressed', String(step <= rating));
      dot.setAttribute('aria-label', WEIGHT_LABEL[key] + ': ' + labels[step]);
      dot.onclick = () => {
        runView.guidance.importance[key] = step;
        renderGuidance();
      };
      scale.append(dot);
    }

    row.append(scale, el('span', 'v', labels[rating] || String(rating)));
    host.append(row);
  });

  // The compiled weights are shown, not edited: someone who wants to know how a
  // rating became a number deserves an answer, and nobody should have to do the
  // arithmetic to express a preference.
  const totalLine = $('weightsTotal');
  const weights = computeWeights(importance);
  totalLine.className = 'status';
  totalLine.textContent =
    'Scored as ' +
    WEIGHT_ORDER.filter((key) => weights[key] > 0)
      .map((key) => (WEIGHT_LABEL[key] || key) + ' ' + weights[key] + '%')
      .join(', ') +
    '.';

  const thresholds = $('thresholds');
  thresholds.replaceChildren();

  [['apply', 'Apply at or above'], ['maybe', 'Maybe at or above']].forEach((entry) => {
    const key = entry[0];
    const value = runView.guidance.decision_thresholds[key];
    if (typeof value !== 'number') return;

    const row = el('div', 'wrow');
    row.append(el('span', undefined, entry[1]));

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(value);
    slider.oninput = (event) => {
      runView.guidance.decision_thresholds[key] = Number(event.target.value);
      renderGuidance();
    };

    row.append(slider, el('span', 'v', String(value)));
    thresholds.append(row);
  });
}

/**
 * The same largest-remainder split the server does, for the preview line.
 *
 * Duplicated deliberately and only for display: the server recomputes it on
 * save, so this can never be what gets stored even if it drifted.
 */
function computeWeights(importance) {
  const ratings = WEIGHT_ORDER.map((key) => Math.max(0, Math.min(5, importance[key] === undefined ? 3 : importance[key])));
  const total = ratings.reduce((sum, rating) => sum + rating, 0);
  const shares = total === 0 ? ratings.map(() => 1) : ratings;
  const sum = shares.reduce((running, share) => running + share, 0);

  const exact = shares.map((share) => (share / sum) * 100);
  const result = exact.map((value) => Math.floor(value));
  let remaining = 100 - result.reduce((running, value) => running + value, 0);

  exact
    .map((value, index) => ({ index: index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach((entry) => {
      if (remaining <= 0) return;
      result[entry.index] += 1;
      remaining -= 1;
    });

  const out = {};
  WEIGHT_ORDER.forEach((key, index) => { out[key] = result[index]; });
  return out;
}

function addPhrase(inputId, list) {
  const input = $(inputId);
  const value = input.value.trim();
  if (value.length === 0) return;
  if (list.indexOf(value) < 0) list.push(value);
  input.value = '';
  renderGuidance();
}

async function saveGuidance() {
  const status = $('guidanceStatus');
  status.textContent = 'Saving...';

  const result = await api('/api/prompt', {
    method: 'PUT',
    body: JSON.stringify({
      direction: runView.guidance.direction,
      importance: runView.guidance.importance,
      decision_thresholds: runView.guidance.decision_thresholds,
    }),
  });

  const problems = $('guidanceProblems');
  problems.replaceChildren();
  ((result.payload || {}).problems || []).forEach((problem) => {
    problems.append(el('div', undefined, problem.path + ': ' + problem.message));
  });

  if (!result.ok) {
    status.textContent = reasonOf(result);
    return;
  }

  status.textContent = 'Saved. The next assessment uses this.';
  runView.promptLoaded = false;
  if ($('promptDetails').open) loadPrompt();
}

/**
 * The prompts, verbatim.
 *
 * Loaded only when the panel is opened: building them means reading a posting
 * and a profile off disk, and most visits to this view are to press Run.
 */
async function loadPrompt() {
  const host = $('promptOut');
  host.replaceChildren(el('div', 'skeleton'));

  const result = await api('/api/prompt');
  const payload = result.payload || {};
  host.replaceChildren();

  if (!result.ok) {
    host.append(el('div', 'status bad', reasonOf(result)));
    return;
  }

  if (payload.guidance) {
    runView.guidance = payload.guidance;
    renderGuidance();
  }

  if (!payload.previewAvailable) {
    host.append(el('div', 'empty', payload.reason || 'No posting is stored yet to preview against.'));
    return;
  }

  const heading = el('div', 'status');
  heading.textContent =
    'Previewed against ' + payload.job.company + ' — ' + payload.job.title +
    '. ' + payload.provider + ', ' + payload.passes + ' pass(es). ' +
    (payload.local ? 'Nothing leaves this machine.' : 'This posting and your profile would be sent to that provider.');
  host.append(heading);

  const facts = el('div', 'status');
  facts.textContent =
    'About ' + payload.estimate.inputTokens + ' tokens in, ' + payload.estimate.outputTokens + ' out' +
    (payload.estimate.costUsd > 0 ? ', roughly $' + payload.estimate.costUsd.toFixed(4) + ' for this role' : '') +
    '. Profile: ' + (payload.profile.exists ? payload.profile.redactions + ' detail(s) redacted before sending' : 'none found') +
    '. Description trimmed from ' + payload.boilerplate.before + ' to ' + payload.boilerplate.after + ' tokens.';
  host.append(facts);

  (payload.requests || []).forEach((request) => {
    host.append(el('div', 'label', request.stage + ' — what the model is told'));
    host.append(el('pre', 'prompt', request.system));
    host.append(el('div', 'label', request.stage + ' — what it is asked'));
    host.append(el('pre', 'prompt', request.prompt + (request.truncated ? '\n\n... truncated for display' : '')));
  });

  runView.promptLoaded = true;
}

function renderSchedule(payload) {
  const host = $('scheduleOut');
  host.replaceChildren();
  host.style.padding = '0';
  host.style.border = '0';
  host.style.textAlign = 'left';

  const build = payload.build || {};

  if (!payload.installed) {
    host.append(el('div', undefined, 'Nothing is scheduled. RoleEye only runs when you run it.'));
  } else {
    const when = el('div');
    when.append(el('b', undefined, payload.nextRun ? 'Next run ' + payload.nextRun : 'Scheduled'));
    host.append(when);

    const detail = el('div');
    detail.textContent =
      'Daily' + (payload.at ? ' at ' + payload.at : '') +
      ', via ' + (payload.scheduler === 'windows' ? 'Task Scheduler' : 'cron') +
      (payload.command ? ', running "' + payload.command + '"' : '') + '.';
    host.append(detail);

    if (!payload.nextRun) {
      host.append(el('div', undefined, 'The scheduler did not report a next run time, which usually means the task is disabled.'));
    }

    if (payload.at) $('scheduleAt').value = payload.at;
  }

  // The scheduler runs the compiled build, not the source. Saying so is the
  // difference between a run that fails at 07:30 with nobody watching and one
  // the user knew to build for.
  if (build.exists === false) {
    host.append(el('div', 'status bad', 'There is no build for the scheduler to run. Run npm run build first.'));
  } else if (build.stale) {
    host.append(
      el('div', 'status bad', 'The build is older than the code. A scheduled run would use the old version — run npm run build.'),
    );
  }
}

async function loadSchedule() {
  const result = await api('/api/schedule');
  if (!result.ok) {
    $('scheduleOut').textContent = reasonOf(result);
    return;
  }
  renderSchedule(result.payload);
}

async function changeSchedule(action) {
  const status = $('scheduleStatus');
  status.className = 'status';
  status.textContent = action === 'install' ? 'Asking the operating system...' : 'Removing...';

  const result = await api('/api/schedule', {
    method: 'POST',
    body: JSON.stringify({ action: action, at: $('scheduleAt').value, command: 'run' }),
  });

  if (!result.ok) {
    status.className = 'status bad';
    status.textContent = reasonOf(result);
    return;
  }

  status.className = 'status ok';
  status.textContent = action === 'install' ? 'Scheduled.' : 'Removed.';
  if (result.payload.schedule) renderSchedule(result.payload.schedule);
  else loadSchedule();
}

async function loadRun() {
  const [options, state] = await Promise.all([api('/api/run/options'), api('/api/run')]);

  if (options.ok) {
    runView.stages = options.payload.stages || runView.stages;
    runView.provider = options.payload.provider || 'none';
    runView.minutesPerRole = options.payload.minutesPerRole;
    if (typeof options.payload.defaultLimit === 'number') runView.limit = options.payload.defaultLimit;
  }

  renderRunStages();
  renderRunLimit();
  renderRunEstimate();

  if (state.ok) applyRunState(state.payload);
  loadSchedule();

  // Guidance without the prompt bodies: the sliders must be usable immediately,
  // and the prompts themselves are the expensive half of that endpoint.
  if (!runView.promptLoaded) {
    const prompt = await api('/api/prompt');
    if (prompt.ok && prompt.payload.guidance) {
      runView.guidance = prompt.payload.guidance;
      renderGuidance();
    }
  }
}

$('runStart').onclick = startRun;
$('runStop').onclick = stopRun;
$('guidanceSave').onclick = saveGuidance;
$('scheduleSave').onclick = () => changeSchedule('install');
$('scheduleRemove').onclick = () => changeSchedule('remove');
$('promptDetails').addEventListener('toggle', () => {
  if ($('promptDetails').open && !runView.promptLoaded) loadPrompt();
});
$('dirPositiveInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); addPhrase('dirPositiveInput', runView.guidance.direction.positive); }
});
$('dirNegativeInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); addPhrase('dirNegativeInput', runView.guidance.direction.negative); }
});

// The controls are built at load rather than when the view is first opened, so
// switching to Run shows a panel instead of a blank frame that fills in.
renderRunStages();
renderRunLimit();
renderGuidance();

// A run outlives the tab that started it, so a reload has to find it again.
// Without this, refreshing during a scan shows an idle page over a live run.
pollRun();
`;
