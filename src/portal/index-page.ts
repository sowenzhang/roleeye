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
 *
 * The review, applications and reports views live in `review-page.ts` and are
 * composed in below. They answer a different question from this one — what was
 * found and what came of it, rather than what to look for — and this file was
 * long enough already.
 */
import { REVIEW_MARKUP, REVIEW_SCRIPT, REVIEW_STYLES } from './review-page.js';
import { RUN_MARKUP, RUN_SCRIPT, RUN_STYLES } from './run-page.js';

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
.coverage {
  margin-top: 22px; padding: 14px 16px; border: 1px solid var(--line);
  border-radius: 12px; background: var(--surface); display: grid; gap: 3px;
}
.coverage b { font-size: 14px; font-weight: 550; }
.coverage span { color: var(--muted); font-size: 12.5px; line-height: 1.5; }
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

/* Model picker: two columns, never three, and never a boxed feature row. */
.engines { display: grid; grid-template-columns: repeat(auto-fit, minmax(252px, 1fr)); gap: 10px; }
.engine {
  display: grid; gap: 7px; text-align: left; width: 100%; font: inherit; color: var(--text);
  border: 1px solid var(--line); background: var(--surface); border-radius: 12px; padding: 14px 15px; cursor: pointer;
  transition: border-color 0.18s var(--ease), background 0.18s var(--ease), transform 0.12s var(--ease);
}
.engine:hover { border-color: var(--line-strong); }
.engine:active { transform: scale(0.99); }
.engine[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-dim); }
.engine .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.engine b { font-weight: 550; font-size: 14px; letter-spacing: -0.01em; }
.engine p { margin: 0; color: var(--muted); font-size: 12.5px; line-height: 1.45; }
.engine .cost { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.engine[aria-pressed="true"] .cost { color: #7fcfae; }
.tag { font-size: 11px; border: 1px solid var(--line-strong); border-radius: 999px; padding: 2px 8px; color: var(--faint); white-space: nowrap; }
.tag.good { color: var(--accent); border-color: #1d6b4f; }
.tag.warn { color: var(--warn); border-color: #6b5320; }

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
button.ghost:disabled { opacity: 0.4; cursor: default; transform: none; border-color: var(--line); }
button.ghost:disabled:hover { border-color: var(--line); }

.status { font-size: 12.5px; color: var(--muted); min-height: 18px; margin-top: 10px; }
.status.ok { color: var(--accent); }
.status.bad { color: var(--danger); }
.problems { margin-top: 10px; display: grid; gap: 5px; }
.problems div { color: var(--danger); font-size: 12.5px; }

.empty { color: var(--faint); font-size: 13px; padding: 22px 0; text-align: center; border: 1px dashed var(--line-strong); border-radius: 10px; }
.alert {
  max-width: 1180px; margin: 0 auto 4px; padding: 13px 16px; border-radius: 10px;
  border: 1px solid #6b5320; background: #21190a; color: #f0d9a8; font-size: 13px; line-height: 1.5;
}
.alert b { display: block; font-weight: 600; margin-bottom: 3px; }
.alert:empty { display: none; padding: 0; border: 0; }
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

const UNREACHABLE =
  'RoleEye is not answering on this port. It has probably stopped — run roleeye ui again and open the link it prints.';
const STALE_TOKEN =
  'This tab is holding a session token from an earlier run. Open the link roleeye ui printed most recently.';
const TIMED_OUT =
  'RoleEye did not answer within 15 seconds. Check the terminal it is running in.';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Every request in this page goes through here, and this never throws.
 *
 * It used to. A rejected fetch — the server stopped, the laptop slept, the port
 * changed — propagated into whichever action had just written "Saving..." into
 * the page, and that word stayed there forever. The user is told the truth
 * instead: the reason is in the payload, and the caller shows it.
 *
 * The timeout matters as much as the catch. A stopped server usually refuses
 * the connection immediately, but a browser holding a keep-alive socket to a
 * process that has gone away waits for the TCP timeout instead — measured at
 * several seconds of "Saving..." with nothing to explain it.
 */
async function api(path, options = {}) {
  let response;
  let timedOut = false;
  let controller;
  let timer;

  if (typeof AbortController === 'function') {
    controller = new AbortController();
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  }

  try {
    response = await fetch(path, {
      ...options,
      ...(controller ? { signal: controller.signal } : {}),
      headers: { 'content-type': 'application/json', 'x-roleeye-token': token, ...(options.headers || {}) },
    });
  } catch (error) {
    // The whole page is dead, not the one panel that happened to ask last.
    // Without saying so at the top, the user reads "not answering" inside the
    // schedule panel and concludes the Remove button is broken.
    raiseOffline(timedOut ? TIMED_OUT : UNREACHABLE);
    return { ok: false, reachable: false, payload: { reason: timedOut ? TIMED_OUT : UNREACHABLE } };
  } finally {
    if (timer !== undefined && typeof clearTimeout === 'function') clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));

  // A restarted portal mints a new token, so an old tab is refused. That is
  // correct, and "403" is not an explanation anybody can act on.
  if (response.status === 403) {
    raiseOffline(STALE_TOKEN);
    return { ok: false, reachable: true, payload: { ...payload, reason: STALE_TOKEN } };
  }

  return { ok: response.ok, reachable: true, payload };
}

let offlineAnnounced = false;

/**
 * Says once, at the top of the page, that nothing here works any more.
 *
 * Once: a dead server fails every poll and every panel, and repainting the
 * banner on each one would fight with whatever else it is showing. It is never
 * cleared, because the fix is to open the link the restarted portal printed,
 * and this tab cannot do that for the user.
 */
function raiseOffline(reason) {
  if (offlineAnnounced) return;
  offlineAnnounced = true;
  if (typeof announce === 'function') announce(reason, 'bad');
}

/** The reason a request failed, in words, whatever the failure was. */
function reasonOf() {
  for (const result of arguments) {
    if (result && !result.ok) {
      const payload = result.payload || {};
      if (payload.reason) return payload.reason;
      if (payload.error) return payload.error;
    }
  }
  return 'Nothing was written. See below.';
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
    screeningEnabled: true, captureMode: 'scoped', extraTitles: [], extraExcludes: [],
  },
  /** The company rule. Named companies appear only in include and exclude. */
  companies: { size: [], ownership: [], sectors: [], include: [], exclude: [] },
  /** Boards added by URL, which no rule can describe. */
  customBoards: [],
  coverage: {},
  filter: '',
  sizes: {},
  ownership: {},
  engines: [],
  reasoning: { provider: 'none', model: '', passes: 2 },
  monthlyBudget: 20,
  dailyLimit: 5,
  detected: null,
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

function tag(text, kind) {
  const span = document.createElement('span');
  span.className = kind ? 'tag ' + kind : 'tag';
  span.textContent = text;
  return span;
}

function costLabel(option) {
  if (option.provider === 'none') return 'no calls';
  if (option.provider === 'agent-cli') return 'included in your subscription';
  if (option.local) return 'free, runs here';
  return '$' + option.estimate.perHundred.toFixed(2) + ' per 100 roles';
}

function renderEngines() {
  const host = $('engines');
  const options = [
    { id: 'none', provider: 'none', label: 'No model', note: 'Screening, history and scoring rules only. Nothing is sent anywhere, ever.', local: true, keyPresent: true },
  ].concat(state.engines);

  host.replaceChildren(
    ...options.map((option) => {
      const picked = state.reasoning.provider === option.provider && (option.provider === 'none' || state.reasoning.model === option.id);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'engine';
      button.setAttribute('aria-pressed', String(picked));

      const top = document.createElement('div');
      top.className = 'top';
      const name = document.createElement('b');
      name.textContent = option.label;
      top.append(name);

      if (option.local && option.provider !== 'none') top.append(tag('stays local', 'good'));
      else if (option.provider === 'agent-cli') top.append(tag('no API key', 'good'));
      else if (!option.keyPresent) top.append(tag('set ' + option.apiKeyEnv, 'warn'));

      const note = document.createElement('p');
      note.textContent = option.note;

      const cost = document.createElement('span');
      cost.className = 'cost';
      cost.textContent = costLabel(option) + (option.requires ? ' - ' + option.requires : '');

      button.append(top, note, cost);
      button.onclick = () => {
        state.reasoning.provider = option.provider;
        state.reasoning.model = option.provider === 'none' ? state.reasoning.model : option.id;
        if (option.command) state.reasoning.command = option.command;
        if (option.baseUrl) state.reasoning.base_url = option.baseUrl;
        if (option.apiKeyEnv) state.reasoning.api_key_env = option.apiKeyEnv;
        if (option.provider !== 'none') {
          state.reasoning.pricing = { input_per_mtok: option.inputPerMtok, output_per_mtok: option.outputPerMtok };
        }
        render();
      };

      return button;
    }),
  );
}

function renderPasses() {
  const host = $('passes');
  const options = [[2, 'Two passes', 'extract, then judge'], [3, 'Three passes', 'adds an adversarial review']];
  host.replaceChildren(
    ...options.map((option) =>
      chip(option[1], option[2], state.reasoning.passes === option[0], () => { state.reasoning.passes = option[0]; }),
    ),
  );
}

function renderDaily() {
  const host = $('daily');
  const options = [3, 5, 10, 20, 40];
  host.replaceChildren(
    ...options.map((value) =>
      chip(String(value) + ' roles', '', state.dailyLimit === value, () => { state.dailyLimit = value; }),
    ),
  );

  const warn = $('dailyWarning');
  const minutes = state.reasoning.provider === 'agent-cli' ? 3.5 * (state.reasoning.passes || 2) : 0.2;
  if (state.dailyLimit > 20) {
    const hours = (state.dailyLimit * minutes) / 60;
    warn.textContent =
      state.dailyLimit + ' roles is a long run: roughly ' +
      (hours >= 1 ? hours.toFixed(1) + ' hours' : Math.round(hours * 60) + ' minutes') +
      ' with the engine you picked.';
    warn.className = 'status bad';
  } else {
    warn.textContent = '';
    warn.className = 'status';
  }
}

function renderBudget() {
  const host = $('budget');
  const options = [0, 5, 20, 50];
  host.replaceChildren(
    ...options.map((value) =>
      chip(value === 0 ? 'No spend' : '$' + value + ' / month', '', state.monthlyBudget === value, () => {
        state.monthlyBudget = value;
      }),
    ),
  );
}

function renderEngineNote() {
  const note = $('engineNote');
  if (state.reasoning.provider === 'none') {
    note.textContent = 'No model selected. Scanning, screening and scope rules still work.';
  } else if (state.detected && state.reasoning.provider === 'ollama' && !state.detected.models.includes(state.reasoning.model)) {
    note.textContent = state.detected.running
      ? 'Ollama is running but has not pulled ' + state.reasoning.model + '. Run: ollama pull ' + state.reasoning.model
      : 'Ollama does not appear to be running on this machine.';
  } else {
    note.textContent = 'Runs only when you ask, on roles that pass screening.';
  }
}

async function detect() {
  const note = $('engineNote');
  note.textContent = 'Looking for a local model...';

  const result = await api('/api/reasoning/detect', { method: 'POST', body: '{}' });
  const payload = result.payload || {};
  state.detected = payload;

  if (!result.ok) {
    note.textContent = reasonOf(result);
    return;
  }

  if (!payload.running) {
    note.textContent = 'No local model server found. Install Ollama to keep everything on this machine.';
    return;
  }

  (payload.models || []).forEach((name) => {
    if (state.engines.some((engine) => engine.id === name)) return;
    state.engines.push({
      id: name, provider: 'ollama', label: name, note: 'Installed on this machine and ready to use.',
      baseUrl: 'http://127.0.0.1:11434/v1', inputPerMtok: 0, outputPerMtok: 0, local: true, keyPresent: true,
      estimate: { perPosting: 0, perHundred: 0, local: true },
    });
  });

  render();
  note.textContent = 'Found ' + payload.models.length + ' local model(s).';
}

/**
 * Which catalog entries the rule selects, mirroring the server's resolver.
 *
 * Facets within a row are OR and rows are AND. An explicit include always wins
 * over the facets; an explicit exclude wins over everything, because that is
 * the user overruling their own rule.
 */
function ruledCompanies() {
  const rule = state.companies;
  const hasFacets = rule.size.length + rule.ownership.length + rule.sectors.length > 0;

  return state.catalog.filter((entry) => {
    if (rule.exclude.indexOf(entry.key) >= 0) return false;
    if (rule.include.indexOf(entry.key) >= 0) return true;
    if (!hasFacets) return false;
    if (rule.size.length > 0 && rule.size.indexOf(entry.size) < 0) return false;
    if (rule.ownership.length > 0 && rule.ownership.indexOf(entry.ownership) < 0) return false;
    if (rule.sectors.length > 0 && rule.sectors.indexOf(entry.category) < 0) return false;
    return true;
  });
}

/** The catalog rows the fine-tuning panel shows, filtered by its own search. */
function catalogMatches() {
  const term = state.filter.trim().toLowerCase();
  if (!term) return state.catalog;

  return state.catalog.filter(
    (entry) =>
      entry.company.toLowerCase().includes(term) ||
      (state.categories[entry.category] || '').toLowerCase().includes(term),
  );
}

function renderFacets() {
  const sizes = $('facetSize');
  sizes.replaceChildren();
  Object.keys(state.sizes).forEach((key) => {
    const info = state.sizes[key];
    sizes.append(
      chip(info.label, info.detail, state.companies.size.indexOf(key) >= 0, () => toggle(state.companies.size, key)),
    );
  });

  const owners = $('facetOwnership');
  owners.replaceChildren();
  Object.keys(state.ownership).forEach((key) => {
    const info = state.ownership[key];
    owners.append(
      chip(info.label, info.detail, state.companies.ownership.indexOf(key) >= 0, () =>
        toggle(state.companies.ownership, key),
      ),
    );
  });

  const sectors = $('facetSector');
  sectors.replaceChildren();
  // Only sectors the catalog actually has, so no chip ever matches nothing.
  const present = [];
  state.catalog.forEach((entry) => {
    if (present.indexOf(entry.category) < 0) present.push(entry.category);
  });
  present.forEach((key) => {
    sectors.append(
      chip(state.categories[key] || key, undefined, state.companies.sectors.indexOf(key) >= 0, () =>
        toggle(state.companies.sectors, key),
      ),
    );
  });
}

/**
 * How many boards this rule reaches, and what it cannot reach at all.
 *
 * The count needs its denominator. "7 companies match" reads as a claim about
 * the world, and invites the entirely reasonable question of where Microsoft
 * and Google are. The honest number is a share of the boards RoleEye can read.
 */
function renderCoverage() {
  const host = $('coverage');
  host.replaceChildren();

  const matched = ruledCompanies();
  const custom = state.customBoards.length;
  const total = state.catalog.length;

  const headline = document.createElement('b');
  headline.textContent =
    matched.length === 0 && custom === 0
      ? 'No companies selected yet'
      : 'Watching ' + matched.length + ' of ' + total + ' boards RoleEye can read' +
        (custom > 0 ? ', plus ' + custom + ' you added' : '');
  host.append(headline);

  const detail = document.createElement('span');
  detail.textContent =
    matched.length === 0 && custom === 0
      ? 'Pick a size, an ownership, or a sector above. Nothing is watched until you do.'
      : 'New companies matching this are picked up automatically. Sizes are approximate.';
  host.append(detail);

  const overrides = state.companies.include.length + state.companies.exclude.length;
  if (overrides > 0) {
    const note = document.createElement('span');
    note.textContent =
      state.companies.include.length + ' added by hand, ' + state.companies.exclude.length + ' removed by hand.';
    host.append(note);
  }
}

function renderWhyMissing() {
  const list = state.coverage.providers || ['Greenhouse', 'Lever', 'Ashby'];
  const providers = list.length > 1 ? list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1] : list[0];

  $('whyMissingText').textContent =
    'RoleEye reads ' + providers + ' boards, which is what most startups and scale-ups use. ' +
    'Large employers such as Microsoft, Google, Amazon and Meta run their own applicant tracking systems ' +
    'and publish no machine-readable board, so no tool can watch them this way. ' +
    'Paste any careers URL below and RoleEye will tell you whether it can read it.';
}

/** How a source entry is named, matching the key the catalog and config use. */
function boardKey(board) {
  const token = board.board !== undefined ? board.board : board.site !== undefined ? board.site : board.url;
  return (board.type + ':' + token).toLowerCase();
}

function renderCustomBoards() {
  const host = $('customBoards');
  host.replaceChildren();
  if (state.customBoards.length === 0) return;

  state.customBoards.forEach((board, index) => {
    const row = document.createElement('div');
    row.className = 'kv';

    const name = document.createElement('span');
    name.textContent = board.company + '  (' + board.type + ')';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost';
    remove.textContent = 'Remove';
    remove.onclick = () => { state.customBoards.splice(index, 1); render(); };

    row.append(name, remove);
    host.append(row);
  });
}

function renderCatalog() {
  const host = $('catalog');
  const matches = catalogMatches();

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
    empty.textContent = 'No board here matches "' + state.filter + '". Add one by URL below.';
    host.append(empty);
    return;
  }

  const watched = {};
  ruledCompanies().forEach((entry) => { watched[entry.key] = true; });

  for (const entry of matches) {
    const picked = watched[entry.key] === true;

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
    const size = (state.sizes[entry.size] || {}).label;
    cat.textContent = [size, state.categories[entry.category] || entry.category].filter(Boolean).join(' · ');
    who.append(name, cat);

    button.append(mark, who);
    // Overriding means recording the disagreement with the rule, not editing a
    // list: the rule has to keep working for every company it was never asked
    // about.
    button.onclick = () => {
      const rule = state.companies;
      if (picked) {
        const at = rule.include.indexOf(entry.key);
        if (at >= 0) rule.include.splice(at, 1);
        if (rule.exclude.indexOf(entry.key) < 0) rule.exclude.push(entry.key);
      } else {
        const at = rule.exclude.indexOf(entry.key);
        if (at >= 0) rule.exclude.splice(at, 1);
        if (rule.include.indexOf(entry.key) < 0) rule.include.push(entry.key);
      }
      render();
    };
    host.append(button);
  }
}

function renderSummary() {
  const roles = state.presets.families.filter((f) => state.selection.families.includes(f.id)).map((f) => f.label);
  const rows = [
    ['Companies', ruledCompanies().length + state.customBoards.length || 'none selected'],
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
  renderFacets();
  renderCoverage();
  renderCustomBoards();
  renderCatalog();
  renderEngines();
  renderPasses();
  renderDaily();
  renderBudget();
  renderEngineNote();
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
  state.selection.companySize = state.companies.size;
  state.selection.companyOwnership = state.companies.ownership;
  state.selection.companySectors = state.companies.sectors;
  state.selection.companyInclude = state.companies.include;
  state.selection.companyExclude = state.companies.exclude;
  state.selection.customBoards = state.customBoards;

  const preferences = await api('/api/preferences', { method: 'PUT', body: JSON.stringify(state.selection) });
  const payload = preferences.payload;

  // The second write is skipped when the first could not be delivered: two
  // identical failures is not twice the information.
  const engine = preferences.reachable === false
    ? preferences
    : await api('/api/reasoning', {
        method: 'PUT',
        body: JSON.stringify({
          reasoning: state.reasoning,
          budget: { max_cost_per_month_usd: state.monthlyBudget, max_jobs_per_scan: state.dailyLimit },
        }),
      });

  const problems = $('problems');
  problems.replaceChildren();
  ((payload || {}).problems || []).concat((engine.payload || {}).problems || []).forEach((problem) => {
    const line = document.createElement('div');
    line.textContent = problem.path + ': ' + problem.message;
    problems.append(line);
  });

  if (preferences.ok && engine.ok) {
    status.className = 'status ok';
    status.textContent = 'Saved. Open Run to start it now, or schedule it there.';
    loadStatus();
  } else {
    status.className = 'status bad';
    status.textContent = reasonOf(preferences, engine);
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

  const key = (payload.type + ':' + payload.token).toLowerCase();
  const known = state.catalog.some((e) => e.key === key);

  if (known) {
    // Already in the catalog, so this is an override rather than a new board.
    const at = state.companies.exclude.indexOf(key);
    if (at >= 0) state.companies.exclude.splice(at, 1);
    if (state.companies.include.indexOf(key) < 0) state.companies.include.push(key);
  } else if (!state.customBoards.some((board) => boardKey(board) === key)) {
    const name = (payload.token + '-' + payload.type).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const board = { name: name, type: payload.type, enabled: true, company: payload.token };
    if (payload.type === 'lever') board.site = payload.token;
    else board.board = payload.token;
    state.customBoards.push(board);
  }

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

  const result = await api('/api/scope-preview', { method: 'POST', body: JSON.stringify({}) });
  const payload = result.payload || {};
  host.replaceChildren();

  if (!result.ok || payload.error) {
    const line = document.createElement('div');
    line.className = 'status bad';
    line.textContent = payload.error || reasonOf(result);
    host.append(line);
    return;
  }

  if (!payload.evaluated) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing stored yet. Save, then open Run to fetch these companies and see what these settings keep.';
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

/**
 * Says so when a file on disk does not load.
 *
 * The portal falls back to defaults in that case, so saving would replace real
 * settings with defaults. The user has to be told before they press save.
 */
function showInvalid(invalid) {
  const host = $('alert');
  host.replaceChildren();
  if (invalid.length === 0) return;

  const title = document.createElement('b');
  title.textContent = 'Showing defaults: ' + invalid.map((entry) => entry.file).join(' and ') + ' could not be read.';
  host.append(title);

  const detail = document.createElement('span');
  const first = (invalid[0].problems || [])[0];
  detail.textContent = first
    ? first.path + ': ' + first.message + '. Saving now replaces that file with what you see here.'
    : 'Saving now replaces that file with what you see here.';
  host.append(detail);
}

async function loadStatus() {
  const { ok, payload } = await api('/api/status');
  if (!ok) return;
  $('statJobs').textContent = payload.jobs;
  $('statSources').textContent = (payload.sources || {}).enabled;
}

/** Says so when the page cannot reach its own server, rather than showing zeros. */
function announce(text, kind) {
  const banner = $('alert');
  banner.className = 'alert ' + (kind || '');
  banner.textContent = text;
}

async function load() {
  const [presets, config, catalog, reasoning] = await Promise.all([
    api('/api/presets'),
    api('/api/config'),
    api('/api/catalog'),
    api('/api/reasoning'),
  ]);

  if (!config.ok || !catalog.ok || !presets.ok || !reasoning.ok) {
    announce(reasonOf(config, catalog, presets, reasoning), 'bad');
    return;
  }

  state.presets = presets.payload;
  state.catalog = catalog.payload.entries || [];
  state.categories = catalog.payload.categories || {};
  state.sizes = catalog.payload.sizes || {};
  state.ownership = catalog.payload.ownership || {};
  state.coverage = catalog.payload.coverage || {};
  state.engines = reasoning.payload.models || [];
  Object.assign(state.reasoning, reasoning.payload.current || {});
  if (typeof (reasoning.payload.budget || {}).max_cost_per_month_usd === 'number') {
    state.monthlyBudget = reasoning.payload.budget.max_cost_per_month_usd;
  }
  if (typeof (reasoning.payload.budget || {}).max_jobs_per_scan === 'number') {
    state.dailyLimit = reasoning.payload.budget.max_jobs_per_scan;
  }
  Object.assign(state.selection, config.payload.selection || {});
  state.selection.captureMode = config.payload.captureMode || 'scoped';

  const companies = config.payload.companies || {};
  state.companies = {
    size: companies.size || [],
    ownership: companies.ownership || [],
    sectors: companies.sectors || [],
    include: companies.include || [],
    exclude: companies.exclude || [],
  };
  state.customBoards = (companies.custom || []).slice();

  $('captureMode').value = state.selection.captureMode;
  $('extraTitles').value = (state.selection.extraTitles || []).join(', ');
  $('extraExcludes').value = (state.selection.extraExcludes || []).join(', ');
  $('paths').textContent = config.payload.locations.criteria;
  showInvalid(config.payload.invalid || []);

  renderWhyMissing();
  render();
  loadStatus();
}

$('search').addEventListener('input', (e) => { state.filter = e.target.value; renderCatalog(); });
$('addUrl').onclick = addByUrl;
$('boardEntry').addEventListener('keydown', (e) => { if (e.key === 'Enter') addByUrl(); });
$('save').onclick = save;
$('detect').onclick = detect;
$('preview').onclick = preview;
$('remoteOnly').onchange = (e) => { state.selection.remoteOnly = e.target.checked; renderSummary(); };
$('rejectRelocation').onchange = (e) => { state.selection.rejectRelocation = e.target.checked; };
$('screeningEnabled').onchange = (e) => { state.selection.screeningEnabled = e.target.checked; };

// The last resort. Every request already reports its own failure; if anything
// else ever breaks mid-action, the user is told rather than left watching a
// word that will not change.
if (typeof addEventListener === 'function') {
  addEventListener('unhandledrejection', (event) => {
    announce('Something went wrong in the page: ' + String((event && event.reason) || 'unknown error'), 'bad');
  });
}

load();
`;

export function renderIndex(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RoleEye</title>
<style>${STYLES}${REVIEW_STYLES}${RUN_STYLES}</style>
</head>
<body>
<header>
  <span class="brand">Role<span>Eye</span></span>
  <span class="tagline">everything stays on this machine</span>
  <nav class="views">
    <button id="nav-setup" type="button" aria-pressed="true">Setup</button>
    <button id="nav-run" type="button" aria-pressed="false">Run</button>
    <button id="nav-review" type="button" aria-pressed="false">Review</button>
    <button id="nav-pipeline" type="button" aria-pressed="false">Applications</button>
    <button id="nav-reports" type="button" aria-pressed="false">Reports</button>
  </nav>
</header>

<div class="alert" id="alert" role="status"></div>

<div class="shell" id="viewSetup">
  <main>
    <section style="--i:0">
      <h2>Companies to watch</h2>
      <p class="hint">Describe the kind of company. RoleEye watches every board it can read that matches, and keeps matching as more are added — you never have to maintain a list.</p>

      <div class="label">Size</div>
      <div class="chips" id="facetSize"></div>

      <div class="label">Ownership</div>
      <div class="chips" id="facetOwnership"></div>

      <div class="label">What they do</div>
      <div class="chips" id="facetSector"></div>

      <div class="coverage" id="coverage"></div>

      <details class="adv" id="tuneCompanies">
        <summary>Add or remove specific companies</summary>
        <div class="body">
          <p class="hint" style="margin:0">Anything you change here overrides the rule above. Removing a company keeps it out even when it matches.</p>
          <div class="search">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3" stroke-linecap="round"/></svg>
            <input type="text" id="search" placeholder="Search by name">
          </div>
          <div class="catalog" id="catalog"></div>
        </div>
      </details>

      <details class="adv" id="whyMissing">
        <summary>Why isn't a company I care about listed?</summary>
        <div class="body">
          <p class="hint" id="whyMissingText" style="margin:0"></p>
          <input type="text" id="boardEntry" placeholder="https://boards.greenhouse.io/yourcompany, or any careers page">
          <div><button class="ghost" id="addUrl" type="button">Check and add</button></div>
          <div class="status" id="boardStatus"></div>
          <div id="customBoards"></div>
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
      <h2>Which model reasons about the shortlist</h2>
      <p class="hint">Scanning, screening and your rules never call a model. This picks what judges fit on the roles that survive. A local model keeps every posting and your profile on this machine.</p>

      <div class="engines" id="engines"></div>

      <div class="rowline" style="margin-top:14px">
        <span class="count" id="engineNote"></span>
        <button class="ghost" id="detect" type="button">Detect local models</button>
      </div>

      <div class="label">Depth</div>
      <div class="scale" id="passes"></div>

      <div class="label">Roles to evaluate per run</div>
      <div class="scale" id="daily"></div>
      <div class="status" id="dailyWarning"></div>

      <div class="label">Stop spending at</div>
      <div class="scale" id="budget"></div>
    </section>

    <section style="--i:5">
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

${RUN_MARKUP}
${REVIEW_MARKUP}

<footer>
  Writes <code id="paths"></code> and the sources file beside it. The CLI reads the same files,
  validated by the same rules. Nothing here calls a model or leaves this machine.
</footer>

<script>${SCRIPT}
${RUN_SCRIPT}
${REVIEW_SCRIPT}</script>
</body>
</html>`;
}
