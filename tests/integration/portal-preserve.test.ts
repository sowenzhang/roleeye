import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { parse } from 'yaml';
import { ConfigService } from '../../src/portal/config-service.js';
import { createRoutes } from '../../src/portal/routes.js';
import { RunService } from '../../src/portal/run-service.js';
import { resolvePaths } from '../../src/config/paths.js';
import { loadConfig } from '../../src/config/load.js';
import { runPipeline } from '../../src/core/pipeline.js';
import { openDatabase } from '../../src/db/database.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { silentLogger } from '../../src/util/logger.js';
import type { RouteHandler } from '../../src/portal/server.js';

/**
 * Saving one panel must never erase another.
 *
 * The portal shows a subset of what the config files hold, and every one of
 * these is the same failure: a page wrote back a field it does not ask about,
 * replacing a real answer with its own constant. The class is already recorded
 * in the decisions log; these are the instances that survived it.
 */

const workspaces: string[] = [];

after(() => {
  for (const dir of workspaces) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle.
    }
  }
});

function workspace(files: { sources?: string; criteria?: string } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'roleeye-preserve-'));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  if (files.sources) writeFileSync(path.join(root, 'config', 'sources.yaml'), files.sources);
  if (files.criteria) writeFileSync(path.join(root, 'config', 'criteria.yaml'), files.criteria);
  workspaces.push(root);
  return root;
}

function routesFor(root: string): Record<string, RouteHandler> {
  const db = openDatabase({ path: ':memory:' });
  return createRoutes({
    config: new ConfigService(resolvePaths(root)),
    logger: silentLogger,
    loadConfig: () => loadConfig({ root, allowDefaults: true }),
    openDb: () => ({ db, repos: createRepositories(db) }),
  });
}

async function savePreferences(root: string, body: Record<string, unknown>) {
  const handler = routesFor(root)['PUT /api/preferences']!;
  return handler({
    method: 'PUT',
    pathname: '/api/preferences',
    query: new URLSearchParams(),
    body: {
      families: ['software'],
      seniority: [],
      locations: [],
      metros: [],
      remoteOnly: false,
      postedWithinDays: 30,
      salaryFloor: 0,
      refuseSystems: [],
      rejectRelocation: true,
      screeningEnabled: true,
      captureMode: 'scoped',
      extraTitles: [],
      extraExcludes: [],
      ...body,
    },
    logger: silentLogger,
  });
}

const yamlOf = (root: string, file: string) =>
  parse(readFileSync(path.join(root, 'config', file), 'utf8')) as Record<string, any>;

describe('saving setup preserves what setup does not ask about', () => {
  it('keeps the prompt direction written on another page', async () => {
    // The setup page compiled `direction: { positive: [], negative: [] }` into
    // every save. Nothing could set direction, so it was inert — until the Run
    // view let people write it, and then Save on setup silently erased it.
    const root = workspace({
      criteria: `version: 1
preferences:
  direction:
    positive:
      - customer-facing AI product work
    negative:
      - internal platform
`,
    });

    const result = await savePreferences(root, {});
    assert.equal(result.status, 200);

    const direction = yamlOf(root, 'criteria.yaml')['preferences'].direction;
    assert.deepEqual(direction.positive, ['customer-facing AI product work']);
    assert.deepEqual(direction.negative, ['internal platform']);
  });

  it('keeps hard filters it has no control for', async () => {
    const root = workspace({
      criteria: `version: 1
hard_filters:
  require_us_payroll: true
  on_unknown:
    salary: reject
    country: reject
`,
    });

    await savePreferences(root, {});
    const filters = yamlOf(root, 'criteria.yaml')['hard_filters'];

    assert.equal(filters.require_us_payroll, true, 'a constant must not overwrite a real answer');
    assert.equal(filters.on_unknown.salary, 'reject');
  });

  it('keeps scope groups the page never shows', async () => {
    const root = workspace({
      sources: `version: 1
sources: []
discovery:
  capture_mode: scoped
  scope:
    titles:
      include: [engineer]
      patterns: ['^staff']
    levels:
      include: [staff]
      exclude: []
    locations:
      countries: [US]
      exclude: [remote - emea]
    departments:
      include: [engineering]
`,
    });

    await savePreferences(root, {});
    const scope = yamlOf(root, 'sources.yaml')['discovery'].scope;

    assert.deepEqual(scope.titles.patterns, ['^staff'], 'a hand-written pattern survives');
    assert.deepEqual(scope.levels.include, ['staff']);
    assert.deepEqual(scope.locations.exclude, ['remote - emea']);
    assert.deepEqual(scope.departments.include, ['engineering'], 'a group with no control at all survives');
  });
});

describe('migrating a named board into the company rule', () => {
  const read = async (root: string) => {
    const handler = routesFor(root)['GET /api/config']!;
    const result = await handler({
      method: 'GET',
      pathname: '/api/config',
      query: new URLSearchParams(),
      body: undefined,
      logger: silentLogger,
    });
    return (result.json as { companies: { include: string[]; custom: Array<Record<string, unknown>> } }).companies;
  };

  it('adopts a board that is exactly what the catalog would have written', async () => {
    const root = workspace({
      sources: `version: 1
sources:
  - name: okta-greenhouse
    type: greenhouse
    company: Okta
    board: okta
    enabled: true
`,
    });

    const companies = await read(root);
    assert.deepEqual(companies.include, ['greenhouse:okta']);
    assert.deepEqual(companies.custom, [], 'nothing is left needing a name');
  });

  it('never adopts a board the user switched off', async () => {
    // Adopting it would drop it from `sources` and let the rule recreate it
    // enabled — turning a board back on that somebody deliberately turned off.
    const root = workspace({
      sources: `version: 1
sources:
  - name: okta-greenhouse
    type: greenhouse
    company: Okta
    board: okta
    enabled: false
`,
    });

    const companies = await read(root);
    assert.deepEqual(companies.include, []);
    assert.equal(companies.custom.length, 1);
    assert.equal(companies.custom[0]!['enabled'], false, 'it stays off, and stays named');
  });

  it('never adopts a board the user renamed or relabelled', async () => {
    // The name is what `--only` selects and what run history is filed under.
    const root = workspace({
      sources: `version: 1
sources:
  - name: my-okta
    type: greenhouse
    company: Okta Identity
    board: okta
    enabled: true
`,
    });

    const companies = await read(root);
    assert.deepEqual(companies.include, []);
    assert.equal(companies.custom[0]!['name'], 'my-okta');
  });

  it('never adopts a board carrying its own scope', async () => {
    const root = workspace({
      sources: `version: 1
sources:
  - name: okta-greenhouse
    type: greenhouse
    company: Okta
    board: okta
    enabled: true
    capture_mode: full
`,
    });

    const companies = await read(root);
    assert.deepEqual(companies.include, [], 'a rule cannot express a capture mode');
    assert.equal(companies.custom[0]!['capture_mode'], 'full');
  });
});

describe('a run reports being stopped', () => {
  it('says cancelled even when the stop lands on the last step', async () => {
    // Abort is checked before each stage and before each role. Stopping during
    // the final one leaves no later checkpoint, so the run used to report that
    // it had finished cleanly.
    const root = workspace({ sources: 'version: 1\nsources: []\n', criteria: 'version: 1\n' });
    const db = openDatabase({ path: ':memory:' });
    const controller = new AbortController();

    const result = await runPipeline({
      config: loadConfig({ root }),
      db,
      repos: createRepositories(db),
      logger: silentLogger,
      stages: ['scan'],
      signal: controller.signal,
      // Aborting from inside the last event is the race this protects against.
      onEvent: (event) => {
        if (event.kind === 'stage-done') controller.abort();
      },
    });

    assert.equal(result.status, 'cancelled');
    db.close();
  });

  it('blames the stage that died when a run cannot start at all', async () => {
    const runs = new RunService({
      logger: silentLogger,
      loadConfig: () => {
        throw new Error('criteria.yaml is not readable');
      },
      openDb: () => {
        throw new Error('unreachable');
      },
    });

    runs.start({ stages: ['scan', 'screen'] });
    await runs.settle();

    const state = runs.snapshot();
    assert.equal(state.status, 'error');
    assert.equal(state.stages[0]!.status, 'failed', 'the first stage is where it died');
    assert.match(String(state.stages[0]!.message), /not readable/);
    assert.notEqual(state.stages[0]!.status, 'skipped', 'a crash is not a decision that there was nothing to do');
  });
});
