import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createRunRoutes } from '../../src/portal/run-routes.js';
import { RunService } from '../../src/portal/run-service.js';
import { ConfigService } from '../../src/portal/config-service.js';
import { runPipeline } from '../../src/core/pipeline.js';
import { acquireRunLock } from '../../src/core/run-lock.js';
import { startPortal, type RunningPortal } from '../../src/portal/server.js';
import { resolvePaths } from '../../src/config/paths.js';
import { loadConfig } from '../../src/config/load.js';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { silentLogger } from '../../src/util/logger.js';

/**
 * Running the pipeline from the portal.
 *
 * The properties worth protecting are that a run can be started and watched
 * from the page, that a second one cannot be started on top of the first, and
 * that stopping is honoured. Configured with no sources, so the run does real
 * work over a real database without touching the network or a model.
 */

const SOURCES = `version: 1
sources: []
`;

const CRITERIA = `version: 1
reasoning:
  provider: none
`;

describe('portal run routes', () => {
  let root: string;
  let db: Database;
  let portal: RunningPortal;
  let runs: RunService;

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'roleeye-run-'));
    mkdirSync(path.join(root, 'config'), { recursive: true });
    writeFileSync(path.join(root, 'config', 'sources.yaml'), SOURCES);
    writeFileSync(path.join(root, 'config', 'criteria.yaml'), CRITERIA);

    const paths = resolvePaths(root);
    db = openDatabase({ path: ':memory:' });
    const repos = createRepositories(db);

    runs = new RunService({
      logger: silentLogger,
      loadConfig: () => loadConfig({ root }),
      openDb: () => ({ db, repos }),
    });

    portal = await startPortal({
      port: 0,
      logger: silentLogger,
      index: () => '<html></html>',
      routes: createRunRoutes({
        logger: silentLogger,
        runs,
        config: new ConfigService(paths),
        loadConfig: () => loadConfig({ root }),
        openDb: () => ({ db, repos }),
        root,
      }),
    });
  });

  after(async () => {
    await runs.settle();
    await portal.close();
    db.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle on the database file.
    }
  });

  async function call(route: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    const response = await fetch(`http://127.0.0.1:${portal.port}${route}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-roleeye-token': portal.token, ...(init.headers ?? {}) },
    });
    return { status: response.status, body: await response.json() };
  }

  async function settle(): Promise<any> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { body } = await call('/api/run');
      if (!body.running) return body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the run never finished');
  }

  it('reports an idle state before anything has run', async () => {
    const { status, body } = await call('/api/run');

    assert.equal(status, 200);
    assert.equal(body.running, false);
    assert.equal(body.status, 'idle');
  });

  it('runs the pipeline and reports what each stage did', async () => {
    const started = await call('/api/run', { method: 'POST', body: JSON.stringify({ stages: ['scan', 'screen'] }) });
    assert.equal(started.status, 200);
    assert.equal(started.body.started, true);

    const final = await settle();

    assert.equal(final.status, 'ok');
    assert.deepEqual(
      final.stages.map((stage: { stage: string }) => stage.stage),
      ['scan', 'screen'],
    );
    assert.ok(
      final.stages.every((stage: { status: string }) => stage.status === 'done'),
      'every stage reports that it finished',
    );
    assert.ok(final.log.length > 0, 'the run leaves a readable trace');
    assert.ok(final.result.screen, 'the screening summary survives into the result');
  });

  it('refuses a second run rather than interleaving two', async () => {
    // Driven through the service rather than over HTTP: a run with no sources
    // finishes in microseconds, so a test that raced two network round trips
    // against it would pass or fail on timing rather than on the guard.
    // Two concurrent runs would write source runs through the same connection
    // and spend the daily budget twice.
    const first = runs.start({ stages: ['scan', 'screen'] });
    assert.equal(first.started, true);

    const second = runs.start({ stages: ['scan'] });
    assert.equal(second.started, false);
    assert.match(String(second.reason), /already in progress/i);

    // Left running, the next test's start would be refused for the wrong reason.
    await runs.settle();
  });

  it('answers a refused start with a conflict, not a silent success', async () => {
    // The mapping from "refused" to 409 is the part the page depends on: a 200
    // would leave it showing a run that was never started.
    const busy = {
      snapshot: () => ({ running: true }),
      start: () => ({ started: false, reason: 'A run is already in progress.', state: { running: true } }),
      cancel: () => ({ cancelling: false }),
    } as unknown as RunService;

    const route = createRunRoutes({
      logger: silentLogger,
      runs: busy,
      config: new ConfigService(resolvePaths(root)),
      loadConfig: () => loadConfig({ root }),
      openDb: () => ({ db, repos: createRepositories(db) }),
      root,
    })['POST /api/run'];

    const result = await route!({
      method: 'POST',
      pathname: '/api/run',
      query: new URLSearchParams(),
      body: {},
      logger: silentLogger,
    });

    assert.equal(result.status, 409);
    assert.equal((result.json as { started: boolean }).started, false);
  });

  it('skips assessment loudly when no engine is configured', async () => {
    // Silently evaluating nothing looks identical to finding nothing.
    await call('/api/run', { method: 'POST', body: JSON.stringify({ stages: ['evaluate'] }) });
    const final = await settle();

    const stage = final.stages.find((entry: { stage: string }) => entry.stage === 'evaluate');
    assert.equal(stage.status, 'skipped');
    assert.match(String(stage.message), /no reasoning engine/i);
  });

  it('says nothing is running rather than pretending to stop something', async () => {
    const { body } = await call('/api/run/cancel', { method: 'POST' });

    assert.equal(body.cancelling, false);
    assert.match(String(body.reason), /nothing is running/i);
  });

  it('refuses to run alongside another process, and says which', async () => {
    // The in-memory guard only covers this process. The scheduled run at 07:30
    // is a different one, and two at once would interleave source runs and
    // apply the per-run spending cap twice over the same window.
    const held = acquireRunLock(db, 'cli');
    assert.equal(held.ok, true);
    if (!held.ok) return;

    try {
      const refused = await call('/api/run', { method: 'POST', body: JSON.stringify({ stages: ['screen'] }) });

      assert.equal(refused.status, 409);
      assert.equal(refused.body.started, false);
      assert.match(String(refused.body.reason), /another roleeye run/i);
      assert.match(String(refused.body.reason), /cli/, 'and it names what is holding it');
    } finally {
      held.lock.release();
    }

    const allowed = await call('/api/run', { method: 'POST', body: JSON.stringify({ stages: ['screen'] }) });
    assert.equal(allowed.body.started, true, 'and lets it through once the other finishes');
    await settle();
  });

  it('does nothing at all when the pipeline itself loses the race', async () => {
    // The portal's up-front check is advisory; the atomic claim inside the
    // pipeline is what decides, and it must leave no half-run behind.
    const held = acquireRunLock(db, 'portal');
    assert.equal(held.ok, true);
    if (!held.ok) return;

    try {
      const result = await runPipeline({
        config: loadConfig({ root }),
        db,
        repos: createRepositories(db),
        logger: silentLogger,
        stages: ['scan', 'screen'],
      });

      assert.equal(result.status, 'busy');
      assert.equal(result.scan, undefined, 'no stage ran');
      assert.equal(result.screen, undefined);
      assert.match(String(result.errors[0]?.message), /another roleeye run/i);
    } finally {
      held.lock.release();
    }
  });

  it('reports the schedule, including when there is not one', async () => {
    const { status, body } = await call('/api/schedule');

    assert.equal(status, 200);
    assert.equal(typeof body.installed, 'boolean');
    assert.ok(['windows', 'cron'].includes(body.scheduler));
  });

  it('refuses a schedule action it does not recognise', async () => {
    const { status, body } = await call('/api/schedule', {
      method: 'POST',
      body: JSON.stringify({ action: 'install; rm -rf /' }),
    });

    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('shows the guidance a user owns even with nothing scanned yet', async () => {
    const { status, body } = await call('/api/prompt');

    assert.equal(status, 200);
    assert.equal(body.previewAvailable, false, 'there is no posting to preview against');
    assert.ok(body.guidance, 'the editable half is still returned, so the sliders work');
    assert.deepEqual(body.guidance.direction, { positive: [], negative: [] });
    assert.equal(body.guidance.weights.career_direction, 20);
  });

  it('writes only the guidance keys, and bounds the free text', async () => {
    const saved = await call('/api/prompt', {
      method: 'PUT',
      body: JSON.stringify({
        direction: {
          positive: ['  customer-facing   AI work  ', '', 'x'.repeat(400), 42],
          negative: Array.from({ length: 40 }, (_, index) => `no ${index}`),
        },
        // Must not reach the file: this endpoint is not a way to rewrite
        // criteria.yaml wholesale.
        budget: { max_cost_per_month_usd: 9_999 },
        reasoning: { provider: 'openai' },
      }),
    });

    assert.equal(saved.status, 200);
    assert.equal(saved.body.saved, true);

    const guidance = saved.body.guidance;
    assert.equal(guidance.direction.positive[0], 'customer-facing AI work', 'whitespace is collapsed');
    assert.equal(guidance.direction.positive.length, 2, 'blanks and non-strings are dropped');
    assert.equal(guidance.direction.positive[1].length, 160, 'a single phrase is bounded');
    assert.equal(guidance.direction.negative.length, 20, 'the list is bounded');

    const criteria = loadConfig({ root }).criteria;
    assert.equal(criteria.reasoning.provider, 'none', 'the engine was not touched');
    assert.notEqual(criteria.budget.max_cost_per_month_usd, 9_999, 'the budget was not touched');
  });

  it('refuses weights that do not total 100, with the reason', async () => {    const { status, body } = await call('/api/prompt', {
      method: 'PUT',
      body: JSON.stringify({ weights: { career_direction: 90 } }),
    });

    assert.equal(status, 400);
    assert.equal(body.saved, false);
    assert.match(String(body.problems[0].message), /total 100/i);
  });

  it('accepts a rating per category and does the arithmetic itself', async () => {
    // The user was being asked to distribute 100 points across seven
    // categories. Nobody rates location at 100%, and everybody has to reach
    // for a calculator, so the constraint mostly produced arithmetic.
    const { status, body } = await call('/api/prompt', {
      method: 'PUT',
      body: JSON.stringify({
        importance: {
          career_direction: 5, hands_on: 4, product_customer: 5, ai_relevance: 5,
          technical_domain: 3, location: 0, compensation: 2,
        },
      }),
    });

    assert.equal(status, 200, 'no combination of ratings can be unsaveable');
    assert.equal(body.saved, true);

    const criteria = loadConfig({ root }).criteria;
    const total = Object.values(criteria.weights).reduce((sum, weight) => sum + weight, 0);

    assert.equal(total, 100, 'weights stay what scoring reads, and stay valid');
    assert.equal(criteria.weights.location, 0, 'a category rated zero is left out');
    assert.equal(criteria.importance?.career_direction, 5, 'and what was chosen is kept as chosen');
    assert.ok(
      criteria.weights.career_direction > criteria.weights.compensation,
      'the ordering the user expressed survives',
    );
  });

  it('clamps a rating the page should never have sent', async () => {
    const { body } = await call('/api/prompt', {
      method: 'PUT',
      body: JSON.stringify({ importance: { career_direction: 99, hands_on: -4, location: 'high' } }),
    });

    assert.equal(body.saved, true);
    assert.equal(body.guidance.importance.career_direction, 5);
    assert.equal(body.guidance.importance.hands_on, 0);
  });

  it('reports whether there is a build for the scheduler to run', async () => {    // The task runs `node dist/index.js run`, not the TypeScript source. A
    // task installed against a missing build fails at 07:30 with nobody
    // watching, which is the worst time for a silent failure.
    const { body } = await call('/api/schedule');

    assert.equal(body.build.exists, false, 'this temporary root has no dist/');
    assert.match(String(body.build.entry), /dist/);

    const install = await call('/api/schedule', {
      method: 'POST',
      body: JSON.stringify({ action: 'install', at: '07:30' }),
    });

    assert.equal(install.status, 400, 'and it refuses rather than scheduling a failure');
    assert.match(String(install.body.reason), /npm run build/i);
  });

  it('answers a bad direction with a reason, not a crash', async () => {
    // `null` passes an `!== undefined` check and then throws on property
    // access, turning malformed input into a 500 with nothing to act on.
    for (const direction of [null, 'nope', ['a']]) {
      const { status, body } = await call('/api/prompt', {
        method: 'PUT',
        body: JSON.stringify({ direction }),
      });

      assert.equal(status, 400, `direction ${JSON.stringify(direction)} must be refused, not thrown on`);
      assert.match(String(body.reason), /direction must be an object/i);
    }
  });

  it('serves the guidance without building every prompt', async () => {
    // The Run view needs this on every visit to draw its sliders; it needs the
    // prompts only when somebody opens the panel, which most visits never do.
    const { status, body } = await call('/api/prompt?guidance=only');

    assert.equal(status, 200);
    assert.equal(body.guidanceOnly, true);
    assert.ok(body.guidance.importance, 'the editable half is there');
    assert.equal(body.requests, undefined, 'and the expensive half is not');
  });
});
