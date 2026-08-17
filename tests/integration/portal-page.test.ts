import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderIndex } from '../../src/portal/index-page.js';
import { createRoutes } from '../../src/portal/routes.js';
import { createRunRoutes } from '../../src/portal/run-routes.js';
import { RunService } from '../../src/portal/run-service.js';
import { ConfigService } from '../../src/portal/config-service.js';
import { startPortal, type RunningPortal } from '../../src/portal/server.js';
import { resolvePaths } from '../../src/config/paths.js';
import { openDatabase } from '../../src/db/database.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { silentLogger } from '../../src/util/logger.js';

/**
 * Executes the page's embedded script against a minimal DOM.
 *
 * The script is a string inside a TypeScript file, so the compiler never sees
 * it and a typo survives every other check. This ran the real page against the
 * real routes and caught a reference error on the first attempt.
 */

interface Node {
  tagName: string;
  children: Node[];
  attrs: Record<string, string>;
  textContent: string;
  [key: string]: unknown;
}

function element(tag: string): Node {
  return {
    tagName: tag,
    children: [],
    attrs: {},
    style: {},
    className: '',
    textContent: '',
    value: '',
    checked: false,
    type: '',
    onclick: null,
    setAttribute(this: Node, key: string, value: string) {
      this.attrs[key] = value;
    },
    append(this: Node, ...kids: Node[]) {
      this.children.push(...kids);
    },
    replaceChildren(this: Node, ...kids: Node[]) {
      this.children = kids;
    },
    addEventListener() {},
  };
}

const workspaces: string[] = [];

after(() => {
  for (const dir of workspaces) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle on the database file.
    }
  }
});

async function renderPage(options: { keepOpen?: boolean; token?: string; hash?: string } = {}): Promise<{
  node: (id: string) => Node;
  missing: Set<string>;
  errors: unknown[];
  portal: RunningPortal;
  location: { hash: string; pathname: string; search: string };
}> {
  const root = mkdtempSync(path.join(tmpdir(), 'roleeye-page-'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  workspaces.push(root);

  const paths = resolvePaths(root);
  const html = renderIndex();

  const registry = new Map<string, Node>();
  const missing = new Set<string>();
  for (const match of html.matchAll(/id="([^"]+)"/g)) registry.set(match[1]!, element('div'));

  const db = openDatabase({ path: ':memory:' });
  const openDb = () => ({ db, repos: createRepositories(db) });
  const config = new ConfigService(paths);
  const loadConfig = () => {
    throw new Error('the page must not need a loaded config to render');
  };

  const portal = await startPortal({
    port: 0,
    logger: silentLogger,
    index: renderIndex,
    routes: {
      ...createRoutes({ config, logger: silentLogger, loadConfig, openDb }),
      // The run view polls on load, so its routes have to be here or the page
      // would be tested against a 404 it happens to survive.
      ...createRunRoutes({
        logger: silentLogger,
        runs: new RunService({ logger: silentLogger, loadConfig, openDb }),
        config,
        loadConfig,
        openDb,
        root,
      }),
    },
  });

  const location = { search: `?token=${options.token ?? portal.token}`, pathname: '/', hash: options.hash ?? '' };

  const errors: unknown[] = [];
  const onRejection = (error: unknown) => errors.push(error);
  process.on('unhandledRejection', onRejection);

  try {
    runInNewContext(html.split('<script>')[1]!.split('</script>')[0]!, {
      document: {
        createElement: element,
        createElementNS: (_ns: string, tag: string) => element(tag),
        getElementById(id: string) {
          if (!registry.has(id)) {
            missing.add(id);
            registry.set(id, element('div'));
          }
          return registry.get(id);
        },
      },
      location,
      URLSearchParams,
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      JSON,
      Promise,
      // The token is not forced in here: the page reads it from the URL, and a
      // harness that supplies the right one regardless cannot test what happens
      // when the page holds the wrong one.
      fetch: (route: string, init?: RequestInit) =>
        fetch(`http://127.0.0.1:${portal.port}${route}`, {
          ...init,
          headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        }),
    });

    await new Promise((resolve) => setTimeout(resolve, 1_500));
  } finally {
    process.off('unhandledRejection', onRejection);
    if (!options.keepOpen) await portal.close();
    if (!options.keepOpen) db.close();
  }

  return { node: (id) => registry.get(id) ?? element('div'), missing, errors, portal, location };
}

describe('portal page', () => {
  it('says so when its own server has gone away, instead of waiting forever', async () => {
    const { node, portal } = await renderPage({ keepOpen: true });

    // The portal was stopped while the tab stayed open — a restarted `roleeye
    // ui`, a closed terminal, a slept laptop. Every fetch now rejects.
    await portal.close();

    const save = node('save') as { onclick?: () => void };
    save.onclick?.();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const status = String(node('saveStatus').textContent);

    assert.notEqual(status, 'Saving...', 'the word must not be left on screen forever');
    assert.match(status, /not answering|roleeye ui/i, 'and it must say what to do about it');
  });

  it('blames the dead server, not the button that happened to ask last', async () => {
    // Reported as "clicking Remove throws an error". The portal had stopped, so
    // every panel was dead — but only the schedule panel said anything, which
    // reads as that one button being broken.
    const { node, portal } = await renderPage({ keepOpen: true });
    await portal.close();

    (node('scheduleRemove') as { onclick?: () => void }).onclick?.();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const banner = node('alert');
    assert.match(String(banner.textContent), /not answering|roleeye ui/i, 'the page says it at the top');
    assert.match(String(banner.className), /bad/);
  });

  it('explains a stale token instead of reporting a bare refusal', async () => {
    // A restarted portal mints a new token, so a tab left open from the last
    // run is refused — correctly, and unhelpfully if it only says 403.
    const { node } = await renderPage({ token: 'a-token-from-an-earlier-run' });

    const save = node('save') as { onclick?: () => void };
    save.onclick?.();
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.match(String(node('saveStatus').textContent), /earlier run|roleeye ui/i);
  });

  it('runs without referencing anything that does not exist', async () => {
    const { missing, errors } = await renderPage();

    assert.deepEqual([...missing], [], 'every element the script touches must exist in the markup');
    assert.deepEqual(errors, [], 'the page must load without a runtime error');
  });

  it('always offers a way to run without sending anything anywhere', async () => {
    const { node } = await renderPage();
    const engines = node('engines').children;

    assert.ok(engines.length >= 3, 'the model choices are rendered');

    const labels = engines.map((engine) => String((engine.children[0]?.children[0] as Node | undefined)?.textContent));
    assert.ok(labels.includes('No model'), 'declining a model is a first-class choice');

    const costs = engines.map((engine) => String((engine.children[2] as Node | undefined)?.textContent));
    assert.ok(
      costs.some((cost) => cost.startsWith('free, runs here')),
      'a local option is offered and named as free',
    );
    assert.ok(
      costs.some((cost) => cost.includes('per 100 roles')),
      'a hosted option states its price before it is chosen',
    );

    const selected = engines.filter((engine) => engine.attrs['aria-pressed'] === 'true');
    assert.equal(selected.length, 1, 'exactly one model is selected at all times');
  });

  it('renders the pickers rather than asking for typed input', async () => {
    const { node } = await renderPage();

    assert.equal(node('passes').children.length, 2, 'depth is chosen, not typed');
    assert.ok(node('budget').children.length >= 3, 'the spending ceiling is chosen, not typed');
    assert.ok(node('catalog').children.length > 20, 'companies come preloaded');
  });

  it('offers a way to start a run from the page it is configured on', async () => {
    // The portal used to describe a pipeline in detail and then tell the user
    // to open a terminal and type three commands in the right order.
    const { node } = await renderPage();

    const stages = node('runStages').children.map((stage) =>
      String((stage.children[1] as { textContent?: unknown } | undefined)?.textContent),
    );
    assert.deepEqual(stages, ['Fetch', 'Filter', 'Assess'], 'each step of the run is a switch the user can see');

    assert.ok(node('runLimit').children.length >= 4, 'how many roles to assess is chosen, not typed');
    assert.equal(node('runStart').disabled, false, 'and the button is live');
  });

  it('lets a kind of company be picked without naming one', async () => {
    // Naming individual companies assumes the user already knows which boards
    // exist, and invites "so where is Google?" — which the catalog cannot
    // answer by listing harder.
    const { node } = await renderPage();

    assert.equal(node('facetSize').children.length, 3, 'size is a facet');
    assert.equal(node('facetOwnership').children.length, 2, 'so is public versus private');
    assert.ok(node('facetSector').children.length >= 8, 'and what they do');
  });

  it('counts coverage against what it can read, not against the world', async () => {
    // "7 companies match" reads as a claim about every company there is. The
    // number only means something beside its denominator.
    const { node } = await renderPage();
    const coverage = node('coverage').children.map((child) => String(child.textContent)).join(' ');

    assert.match(coverage, /no companies selected yet/i, 'nothing is watched before anything is chosen');
    assert.match(coverage, /nothing is watched until you do/i);
  });

  it('says why a large employer is missing rather than leaving it unexplained', async () => {
    const { node } = await renderPage();
    const text = String(node('whyMissingText').textContent);

    assert.match(text, /Greenhouse|Lever|Ashby/, 'it names what it can read');
    assert.match(text, /Microsoft|Google|Amazon/, 'and the obvious absences');
    assert.match(text, /own applicant tracking/i, 'with the actual reason');
  });

  it('keeps individual companies out of the way until they are asked for', async () => {
    // The catalog is now a fine-tuning tool, not the way to configure this.
    const html = renderIndex();
    const tuning = html.slice(html.indexOf('id="tuneCompanies"'));

    assert.ok(tuning.indexOf('id="catalog"') > 0, 'the grid lives inside the disclosure');
    assert.ok(
      html.indexOf('id="tuneCompanies"') < html.indexOf('id="catalog"'),
      'and the disclosure comes first, so the grid is collapsed by default',
    );
  });

  it('gives each view its own address', async () => {
    // Four sections behind one URL means no deep link, no back button, and a
    // reload that always lands on setup.
    const { node, location } = await renderPage();

    assert.equal(location.hash, '#/setup', 'the opening view names itself');

    (node('nav-review') as { onclick?: () => void }).onclick?.();
    assert.equal(location.hash, '#/review');

    (node('nav-run') as { onclick?: () => void }).onclick?.();
    assert.equal(location.hash, '#/run');
  });

  it('opens the view the address asks for', async () => {
    const { node, location } = await renderPage({ hash: '#/reports' });
    const display = (id: string) => (node(id).style as { display?: string }).display;

    assert.equal(location.hash, '#/reports');
    assert.equal(display('viewReports'), '', 'the requested view is shown');
    assert.equal(display('viewSetup'), 'none', 'and the default one is not');
  });

  it('falls back to setup when the address names a view that does not exist', async () => {
    const { node, location } = await renderPage({ hash: '#/../etc/passwd' });

    assert.equal((node('viewSetup').style as { display?: string }).display, '', 'an unknown view is not a blank page');
    assert.equal(location.hash, '#/setup', 'and the address is corrected to match');
  });
});
