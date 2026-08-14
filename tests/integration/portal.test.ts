import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { parse } from 'yaml';
import { ConfigService } from '../../src/portal/config-service.js';
import { createRoutes } from '../../src/portal/routes.js';
import { renderIndex } from '../../src/portal/index-page.js';
import { isAllowedOrigin, isLoopbackHost, startPortal } from '../../src/portal/server.js';
import { resolvePaths } from '../../src/config/paths.js';
import { criteriaSchema, sourcesSchema } from '../../src/config/schema.js';
import { openDatabase } from '../../src/db/database.js';
import { createRepositories } from '../../src/db/repositories/index.js';
import { silentLogger } from '../../src/util/logger.js';

const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'roleeye-portal-'));
  mkdirSync(path.join(dir, 'config'), { recursive: true });
  workspaces.push(dir);
  return dir;
}

after(() => {
  for (const dir of workspaces) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle; a temp directory is harmless.
    }
  }
});

describe('portal config service', () => {
  it('returns usable defaults before any file exists', () => {
    const service = new ConfigService(resolvePaths(workspace()));

    const criteria = service.readCriteria();
    const sources = service.readSources();

    assert.equal(criteria.exists, false);
    assert.equal(sources.exists, false);
    assert.equal(criteria.value.decision_thresholds.apply, 78, 'the portal opens on schema defaults');
  });

  it('writes YAML the CLI loader accepts', () => {
    const root = workspace();
    const service = new ConfigService(resolvePaths(root));

    const result = service.saveSources({
      sources: [{ name: 'acme', type: 'greenhouse', company: 'Acme', board: 'acme' }],
      discovery: { capture_mode: 'scoped', scope: { titles: { include: ['engineer'] } } },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const reloaded = sourcesSchema.safeParse(parse(readFileSync(result.path, 'utf8')));
    assert.equal(reloaded.success, true, 'what the portal writes is what the CLI reads');
    if (!reloaded.success) return;
    assert.equal(reloaded.data.sources[0]?.company, 'Acme');
  });

  it('refuses invalid configuration and writes nothing', () => {
    const root = workspace();
    const service = new ConfigService(resolvePaths(root));
    const file = service.locations().criteria;

    const result = service.saveCriteria({ weights: { career_direction: 50 } });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.problems.some((problem) => problem.message.includes('total 100')));
    assert.throws(() => readFileSync(file, 'utf8'), 'a rejected save must not leave a partial file');
  });

  it('still opens a file the loader would reject', () => {
    const root = workspace();
    const service = new ConfigService(resolvePaths(root));
    writeFileSync(service.locations().sources, 'sources: "not a list"\n');

    const document = service.readSources();

    assert.equal(document.exists, true);
    assert.deepEqual(document.value.sources, [], 'the portal must open exactly when config is broken');
  });
});

describe('portal security', () => {
  it('recognises loopback hosts only', () => {
    assert.equal(isLoopbackHost('127.0.0.1:7777'), true);
    assert.equal(isLoopbackHost('localhost:7777'), true);
    assert.equal(isLoopbackHost('[::1]:7777'), true);
    assert.equal(isLoopbackHost('192.168.1.9:7777'), false);
    assert.equal(isLoopbackHost('roleeye.example.com'), false);
    assert.equal(isLoopbackHost(undefined), false);
  });

  it('accepts same-origin and refuses foreign origins', () => {
    assert.equal(isAllowedOrigin(undefined, 7777), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:7777', 7777), true);
    assert.equal(isAllowedOrigin('http://evil.example', 7777), false);
    assert.equal(isAllowedOrigin('http://127.0.0.1:8888', 7777), false);
  });

  it('enforces the token, the origin, and the host over real HTTP', async () => {
    const root = workspace();
    const service = new ConfigService(resolvePaths(root));

    const portal = await startPortal({
      port: 0,
      logger: silentLogger,
      index: renderIndex,
      routes: createRoutes({
        config: service,
        logger: silentLogger,
        loadConfig: () => {
          throw new Error('not needed');
        },
        openDb: () => ({ repos: createRepositories(openDatabase({ path: ':memory:' })) }),
      }),
    });

    try {
      const base = `http://127.0.0.1:${portal.port}`;
      const payload = JSON.stringify({ sources: [] });

      const noToken = await fetch(`${base}/api/config/sources`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      assert.equal(noToken.status, 403, 'a write without the token is refused');

      const foreignOrigin = await fetch(`${base}/api/config/sources`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-roleeye-token': portal.token, origin: 'http://evil.example' },
        body: payload,
      });
      assert.equal(foreignOrigin.status, 403, 'another tab cannot drive the agent');

      const reads = await fetch(`${base}/api/config`);
      assert.equal(reads.status, 200, 'reads do not need the token');

      const accepted = await fetch(`${base}/api/config/sources`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-roleeye-token': portal.token },
        body: payload,
      });
      assert.equal(accepted.status, 200);

      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    } finally {
      await portal.close();
    }
  });

  it('binds loopback only', async () => {
    const portal = await startPortal({
      port: 0,
      logger: silentLogger,
      index: renderIndex,
      routes: {},
    });

    try {
      const address = portal.server.address();
      assert.ok(address && typeof address === 'object');
      assert.equal(address.address, '127.0.0.1', 'never 0.0.0.0');
    } finally {
      await portal.close();
    }
  });
});

describe('portal page', () => {
  it('renders without a bundler and never assigns innerHTML', () => {
    const html = renderIndex();

    assert.match(html, /<title>RoleEye<\/title>/);
    assert.match(html, /id="catalog"/);
    // Company names and job titles are third-party text: nodes only, never markup.
    assert.match(html, /textContent = /);
    assert.ok(!/\.innerHTML\s*=/.test(html), 'innerHTML must never be assigned on this page');
  });

  it('offers pickers rather than free-text boxes for the main settings', () => {
    const html = renderIndex();

    for (const id of ['families', 'seniority', 'locations', 'salary', 'recency', 'systems']) {
      assert.match(html, new RegExp(`id="${id}"`), `${id} must be a picker`);
    }

    // Free text survives only in the advanced panel.
    const textInputs = [...html.matchAll(/<input type="text"[^>]*id="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(textInputs.sort(), ['boardEntry', 'extraExcludes', 'extraTitles', 'search'].sort());
  });

  it('contains no emoji', () => {
    assert.ok(!/\p{Extended_Pictographic}/u.test(renderIndex()));
  });
});

describe('portal routes', () => {
  function harness() {
    const root = workspace();
    const service = new ConfigService(resolvePaths(root));
    const db = openDatabase({ path: ':memory:' });

    return {
      root,
      service,
      routes: createRoutes({
        config: service,
        logger: silentLogger,
        loadConfig: () => {
          throw new Error('not needed for this route');
        },
        openDb: () => ({ repos: createRepositories(db) }),
      }),
    };
  }

  it('reports status on an empty install', async () => {
    const { routes } = harness();
    const result = await routes['GET /api/status']?.({
      method: 'GET',
      pathname: '/api/status',
      query: new URLSearchParams(),
      body: undefined,
      logger: silentLogger,
    });

    assert.equal(result?.status, 200);
    const json = result?.json as { jobs: number; configured: boolean };
    assert.equal(json.jobs, 0);
    assert.equal(json.configured, false);
  });

  it('returns field-level problems rather than a generic failure', async () => {
    const { routes } = harness();
    const result = await routes['PUT /api/config/criteria']?.({
      method: 'PUT',
      pathname: '/api/config/criteria',
      query: new URLSearchParams(),
      body: { decision_thresholds: { apply: 10, maybe: 90 } },
      logger: silentLogger,
    });

    assert.equal(result?.status, 400);
    const json = result?.json as { problems: Array<{ path: string; message: string }> };
    assert.ok(json.problems.length > 0);
    assert.ok(json.problems[0]?.path.includes('decision_thresholds'));
  });

  it('previews scope from unsaved edits without writing them', async () => {
    const { routes, service } = harness();

    const result = await routes['POST /api/scope-preview']?.({
      method: 'POST',
      pathname: '/api/scope-preview',
      query: new URLSearchParams(),
      body: { sources: { discovery: { capture_mode: 'scoped', scope: { titles: { include: ['engineer'] } } } } },
      logger: silentLogger,
    });

    assert.equal(result?.status, 200);
    assert.equal(service.readSources().exists, false, 'previewing must not save');
  });

  it('rejects an invalid preview payload with problems', async () => {
    const { routes } = harness();

    const result = await routes['POST /api/scope-preview']?.({
      method: 'POST',
      pathname: '/api/scope-preview',
      query: new URLSearchParams(),
      body: { sources: { sources: 'not-a-list' } },
      logger: silentLogger,
    });

    assert.equal(result?.status, 400);
  });

  it('refuses to merge into a config file it could not read', async () => {
    const { routes, service } = harness();

    // A file the schema rejects: the portal shows defaults, so a merge-and-save
    // would replace every hand-written setting with a default.
    const file = service.locations().criteria;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'weights:\n  career_direction: 20\n  not_a_real_weight: 80\n');

    const result = await routes['PUT /api/reasoning']?.({
      method: 'PUT',
      pathname: '/api/reasoning',
      query: new URLSearchParams(),
      body: { reasoning: { provider: 'ollama', model: 'qwen2.5:14b' } },
      logger: silentLogger,
    });

    assert.equal(result?.status, 400);
    assert.match(String((result?.json as { reason: string }).reason), /overwrite/i);
    assert.match(readFileSync(file, 'utf8'), /not_a_real_weight/, 'the file must be left exactly as it was');
  });

  it('offers a model list with costs and no secrets in it', async () => {
    const { routes } = harness();

    const result = await routes['GET /api/reasoning']?.({
      method: 'GET',
      pathname: '/api/reasoning',
      query: new URLSearchParams(),
      body: undefined,
      logger: silentLogger,
    });

    assert.equal(result?.status, 200);
    const json = result?.json as {
      models: Array<{ id: string; local: boolean; keyPresent: boolean; estimate: { perHundred: number } }>;
    };

    assert.ok(json.models.some((model) => model.local), 'a local option must always be offered');
    assert.ok(json.models.some((model) => !model.local && model.estimate.perHundred > 0), 'hosted options state a price');

    const serialized = JSON.stringify(json);
    assert.ok(!/sk-[A-Za-z0-9]/.test(serialized), 'no key material may reach the browser');
  });

  it('changes the model without disturbing the rest of the criteria', async () => {
    const { routes, service } = harness();

    // Something the user configured earlier that the model panel knows nothing about.
    const seeded = service.saveCriteria({
      decision_thresholds: { apply: 91, maybe: 70 },
      hard_filters: { minimum_base_salary: { amount: 210_000, currency: 'USD' } },
    });
    assert.equal(seeded.ok, true);

    const result = await routes['PUT /api/reasoning']?.({
      method: 'PUT',
      pathname: '/api/reasoning',
      query: new URLSearchParams(),
      body: {
        reasoning: { provider: 'ollama', model: 'qwen2.5:14b', base_url: 'http://127.0.0.1:11434/v1', passes: 3 },
        budget: { max_cost_per_month_usd: 5 },
      },
      logger: silentLogger,
    });

    assert.equal(result?.status, 200);

    const reloaded = criteriaSchema.parse(parse(readFileSync(service.locations().criteria, 'utf8')));
    assert.equal(reloaded.reasoning.provider, 'ollama');
    assert.equal(reloaded.reasoning.passes, 3);
    assert.equal(reloaded.budget.max_cost_per_month_usd, 5);
    assert.equal(reloaded.decision_thresholds.apply, 91, 'unrelated settings survive a model change');
    assert.equal(reloaded.hard_filters.minimum_base_salary?.amount, 210_000);
    assert.equal(reloaded.budget.max_jobs_per_scan, 40, 'unset budget fields keep their value');
  });

  it('reports a missing local model server rather than hanging', async () => {
    const { routes } = harness();

    const result = await routes['POST /api/reasoning/detect']?.({
      method: 'POST',
      pathname: '/api/reasoning/detect',
      query: new URLSearchParams(),
      body: {},
      logger: silentLogger,
    });

    assert.equal(result?.status, 200);
    const json = result?.json as { running: boolean; models: string[] };
    assert.equal(typeof json.running, 'boolean');
    assert.ok(Array.isArray(json.models));
  });
});

describe('generated criteria', () => {
  it('round-trips through the schema unchanged', () => {
    const base = criteriaSchema.parse({});
    const again = criteriaSchema.parse(base);
    assert.deepEqual(again, base, 'saving an untouched config must not drift');
  });
});
