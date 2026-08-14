import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { runScan, passesDiscoveryFilters } from '../../src/discovery/scan.js';
import { getAdapter } from '../../src/discovery/registry.js';
import { criteriaSchema, sourcesSchema, syncSchema } from '../../src/config/schema.js';
import { archetypesSchema } from '../../src/config/archetype-schema.js';
import type { AppConfig } from '../../src/config/load.js';
import type { HttpClient } from '../../src/discovery/source-adapter.js';
import { silentLogger } from '../../src/util/logger.js';
import { boardUrl } from '../../src/discovery/greenhouse.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixturePayload(): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, 'greenhouse', 'board.json'), 'utf8'));
}

function buildConfig(overrides?: { sources?: unknown }): AppConfig {
  const sources = sourcesSchema.parse(
    overrides?.sources ?? {
      sources: [
        { name: 'examplecorp', type: 'greenhouse', company: 'Example Corp', board: 'examplecorp' },
        { name: 'brokencorp', type: 'greenhouse', company: 'Broken Corp', board: 'brokencorp' },
      ],
    },
  );

  return {
    env: {
      logLevel: 'error',
      reasoningProvider: 'none',
      embeddingProvider: 'none',
      paths: {
        root: '.',
        configDir: './config',
        profileDir: './profile',
        dataDir: './data',
        artifactsDir: './artifacts',
        exportDir: './export',
        dbPath: ':memory:',
      },
    },
    criteria: criteriaSchema.parse({}),
    sources,
    sync: syncSchema.parse({}),
    archetypes: archetypesSchema.parse({}),
    loadedFiles: [],
    missingFiles: [],
  };
}

/** Offline HTTP stub: one board succeeds, the other always fails. */
function stubHttp(): HttpClient {
  return {
    getText: async () => '',
    getJson: async (url: string) => {
      if (url === boardUrl('examplecorp')) return fixturePayload() as never;
      throw new Error('HTTP 503 Service Unavailable');
    },
  };
}

describe('scan pipeline', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  it('continues when one source fails and records the failure', async () => {
    const config = buildConfig();
    const summary = await runScan({ config, db, repos, logger: silentLogger, http: stubHttp() });

    assert.equal(summary.status, 'warning');
    assert.equal(summary.sources.length, 2);

    const ok = summary.sources.find((source) => source.sourceName === 'examplecorp');
    const failed = summary.sources.find((source) => source.sourceName === 'brokencorp');

    assert.equal(ok?.status, 'ok');
    assert.equal(ok?.new, 3);
    assert.equal(failed?.status, 'failed');
    assert.match(failed?.error ?? '', /503/);

    assert.equal(repos.jobs.count(), 3, 'the healthy source still persisted its jobs');

    const runs = repos.scans.listRunsForScan(summary.scanId);
    assert.equal(runs.length, 2);
    assert.equal(runs.filter((run) => run.status === 'failed').length, 1);
  });

  it('is idempotent when the same scan runs twice', async () => {
    const config = buildConfig();
    await runScan({ config, db, repos, logger: silentLogger, http: stubHttp() });
    const second = await runScan({ config, db, repos, logger: silentLogger, http: stubHttp() });

    assert.equal(repos.jobs.count(), 3);
    assert.equal(second.totals.new, 0);
    assert.equal(second.totals.unchanged, 3);
  });

  it('restricts the scan with --source', async () => {
    const config = buildConfig();
    const summary = await runScan({
      config,
      db,
      repos,
      logger: silentLogger,
      http: stubHttp(),
      only: ['examplecorp'],
    });

    assert.equal(summary.sources.length, 1);
    assert.equal(summary.status, 'ok');
    assert.equal(repos.jobs.count(), 3);
  });

  it('applies scope filtering from the legacy discovery_filters block', async () => {
    const config = buildConfig({
      sources: {
        sources: [{ name: 'examplecorp', type: 'greenhouse', company: 'Example Corp', board: 'examplecorp' }],
        discovery_filters: { title_exclude: ['intern'] },
      },
    });

    const summary = await runScan({ config, db, repos, logger: silentLogger, http: stubHttp() });
    assert.equal(summary.sources[0]?.outOfScope, 1);
    assert.equal(repos.jobs.count(), 2, 'the intern posting is not stored in scoped mode');
  });

  it('registers an adapter for every configured source type', () => {
    for (const type of ['greenhouse', 'lever', 'ashby', 'career-page'] as const) {
      assert.ok(getAdapter(type), `${type} adapter must be registered`);
    }
  });

  it('isolates a failing source from a healthy one', async () => {
    const config = buildConfig({
      sources: {
        sources: [
          { name: 'examplecorp', type: 'greenhouse', company: 'Example Corp', board: 'examplecorp' },
          { name: 'later', type: 'lever', company: 'Later Corp', site: 'later' },
        ],
      },
    });

    const summary = await runScan({ config, db, repos, logger: silentLogger, http: stubHttp() });
    assert.equal(summary.status, 'warning');
    assert.equal(repos.jobs.count(), 3, 'the healthy source still persisted');
    assert.match(summary.sources.find((entry) => entry.sourceName === 'later')?.error ?? '', /fetch failed/);
  });

  it('writes nothing during a dry run', async () => {
    const config = buildConfig();
    const summary = await runScan({ config, db, repos, logger: silentLogger, http: stubHttp(), dryRun: true });

    assert.equal(summary.sources[0]?.fetched, 3);
    assert.equal(repos.jobs.count(), 0);
  });

  it('caps how many new roles a single source may contribute per scan', async () => {
    const config = buildConfig({
      sources: {
        sources: [{ name: 'examplecorp', type: 'greenhouse', company: 'Example Corp', board: 'examplecorp' }],
        discovery: { scope: { max_new_per_source_per_scan: 2 } },
      },
    });

    const first = await runScan({ config, db, repos, logger: silentLogger, http: stubHttp() });
    assert.equal(first.sources[0]?.deferred, 1);
    assert.equal(repos.jobs.count(), 2);

    // Nothing was recorded about the deferred role, so the next scan picks it up.
    const second = await runScan({ config, db, repos, logger: silentLogger, http: stubHttp() });
    assert.equal(second.sources[0]?.new, 1, 'the deferred role is admitted next time');
    assert.equal(repos.jobs.count(), 3);
  });

  it('keeps refreshing known roles while the cap defers new ones', async () => {
    const uncapped = buildConfig({
      sources: {
        sources: [{ name: 'examplecorp', type: 'greenhouse', company: 'Example Corp', board: 'examplecorp' }],
      },
    });
    await runScan({ config: uncapped, db, repos, logger: silentLogger, http: stubHttp() });

    const capped = buildConfig({
      sources: {
        sources: [{ name: 'examplecorp', type: 'greenhouse', company: 'Example Corp', board: 'examplecorp' }],
        discovery: { scope: { max_new_per_source_per_scan: 1 } },
      },
    });
    const summary = await runScan({ config: capped, db, repos, logger: silentLogger, http: stubHttp() });

    assert.equal(summary.sources[0]?.unchanged, 3, 'every known role is still observed');
    assert.equal(summary.sources[0]?.closed, 0, 'and none of them is retired');
  });

  it('honours a per-source capture mode override', async () => {
    const config = buildConfig({
      sources: {
        sources: [
          {
            name: 'examplecorp',
            type: 'greenhouse',
            company: 'Example Corp',
            board: 'examplecorp',
            capture_mode: 'history',
          },
        ],
      },
    });

    await runScan({ config, db, repos, logger: silentLogger, http: stubHttp() });

    const jobs = repos.jobs.list({ limit: 10, inScope: undefined });
    assert.equal(jobs.length, 3);
    for (const job of jobs) {
      assert.equal(job.descriptionText, '');
      assert.equal(repos.postings.listForJob(job.id)[0]?.captureMode, 'history');
    }
  });

  it('closes roles a source stopped advertising, but only after a successful run', async () => {
    const config = buildConfig({
      sources: {
        sources: [{ name: 'examplecorp', type: 'greenhouse', company: 'Example Corp', board: 'examplecorp' }],
      },
    });

    await runScan({ config, db, repos, logger: silentLogger, http: stubHttp() });
    assert.equal(repos.jobs.count(), 3);

    // The board now lists only the first role.
    const shrunk: HttpClient = {
      getText: async () => '',
      getJson: async (url: string) => {
        if (url !== boardUrl('examplecorp')) throw new Error('HTTP 503 Service Unavailable');
        const payload = fixturePayload() as { jobs: unknown[] };
        return { ...payload, jobs: payload.jobs.slice(0, 1) } as never;
      },
    };

    const summary = await runScan({ config, db, repos, logger: silentLogger, http: shrunk });

    assert.equal(summary.sources[0]?.closed, 2);
    assert.equal(repos.jobs.list({ limit: 10 }).length, 1, 'closed roles leave the default listing');
    assert.equal(repos.jobs.list({ limit: 10, includeClosed: true }).length, 3, 'nothing is deleted');
  });

  it('does not close anything when the source run fails', async () => {
    const config = buildConfig({
      sources: {
        sources: [{ name: 'examplecorp', type: 'greenhouse', company: 'Example Corp', board: 'examplecorp' }],
      },
    });

    await runScan({ config, db, repos, logger: silentLogger, http: stubHttp() });

    const failing: HttpClient = {
      getText: async () => '',
      getJson: async () => {
        throw new Error('HTTP 503 Service Unavailable');
      },
    };

    const summary = await runScan({ config, db, repos, logger: silentLogger, http: failing });

    assert.equal(summary.status, 'failed');
    assert.equal(repos.jobs.list({ limit: 10 }).length, 3, 'a failed fetch must never retire live roles');
  });
});

describe('passesDiscoveryFilters', () => {
  const filters = { title_include: ['engineer'], title_exclude: ['intern'] };

  it('excludes before including', () => {
    assert.equal(passesDiscoveryFilters('Engineer Intern', filters), false);
    assert.equal(passesDiscoveryFilters('Staff Engineer', filters), true);
    assert.equal(passesDiscoveryFilters('Product Manager', filters), false);
  });

  it('keeps everything when no include list is set', () => {
    assert.equal(passesDiscoveryFilters('Product Manager', { title_include: [], title_exclude: [] }), true);
  });
});
