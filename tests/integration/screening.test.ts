import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { ingestJob } from '../../src/discovery/ingest.js';
import { runScreening, screenJob } from '../../src/evaluate/screen.js';
import { criteriaHash } from '../../src/evaluate/criteria.js';
import { criteriaSchema } from '../../src/config/schema.js';
import type { DiscoveredJob } from '../../src/core/types.js';

const NOW = '2026-09-20T00:00:00.000Z';

function discovered(over: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    sourceType: 'greenhouse',
    sourceName: 'acme',
    sourceJobId: 'gh-1',
    companyName: 'Acme',
    title: 'Staff Platform Engineer',
    location: 'Seattle, WA',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    descriptionHtml: `<p>Build distributed systems with a small team.</p><p>${'Work on interesting problems. '.repeat(20)}</p>`,
    salary: { min: 210_000, max: 260_000, currency: 'USD', period: 'year' },
    ...over,
  };
}

function ingest(repos: Repositories, job: DiscoveredJob, when = '2026-08-01T00:00:00.000Z') {
  return ingestJob(repos, job, { seenAt: when, scanId: undefined, repostGapDays: 21, captureMode: 'full' });
}

const criteria = criteriaSchema.parse({
  hard_filters: {
    countries: ['US'],
    minimum_base_salary: { amount: 200_000, currency: 'USD' },
  },
  preferences: { application_system: { deny: ['workday'] } },
});

describe('screening pipeline', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  it('marks a qualifying role eligible and records why', () => {
    ingest(repos, discovered());

    const summary = runScreening(repos, { criteria, now: NOW });

    assert.equal(summary.screened, 1);
    assert.equal(summary.eligible, 1);
    assert.equal(summary.rejected, 0);

    const screening = repos.screenings.listEligible(summary.criteriaHash)[0];
    assert.ok(screening);
    assert.equal(screening.authenticity.fraudRisk, 'low');
  });

  it('rejects on salary and reports the rule', () => {
    ingest(repos, discovered({ salary: { min: 120_000, max: 140_000, currency: 'USD', period: 'year' } }));

    const summary = runScreening(repos, { criteria, now: NOW });

    assert.equal(summary.eligible, 0);
    assert.deepEqual(summary.rejectionsByRule, { salary: 1 });
  });

  it('blocks a posting with scam markers', () => {
    ingest(
      repos,
      discovered({
        descriptionHtml: '<p>You will need to purchase a starter kit before your first day.</p>',
      }),
    );

    const summary = runScreening(repos, { criteria, now: NOW });

    assert.equal(summary.blocked, 1);
    assert.equal(repos.screenings.listEligible(summary.criteriaHash).length, 0, 'blocked roles are never offered');
  });

  it('reuses a current screening instead of re-deciding', () => {
    ingest(repos, discovered());

    const first = runScreening(repos, { criteria, now: NOW });
    const second = runScreening(repos, { criteria, now: NOW });

    assert.equal(first.screened, 1);
    assert.equal(second.screened, 0);
    assert.equal(second.reused, 1);
  });

  it('re-screens when the criteria change', () => {
    ingest(repos, discovered());
    runScreening(repos, { criteria, now: NOW });

    const stricter = criteriaSchema.parse({
      hard_filters: { countries: ['US'], minimum_base_salary: { amount: 300_000, currency: 'USD' } },
    });
    const summary = runScreening(repos, { criteria: stricter, now: NOW });

    assert.equal(summary.screened, 1, 'a rules change produces a new decision');
    assert.equal(summary.eligible, 0);
    assert.notEqual(summary.criteriaHash, criteriaHash(criteria));
  });

  it('keeps the earlier decision under the earlier rules', () => {
    ingest(repos, discovered());
    const original = runScreening(repos, { criteria, now: NOW });

    const stricter = criteriaSchema.parse({
      hard_filters: { minimum_base_salary: { amount: 300_000, currency: 'USD' } },
    });
    runScreening(repos, { criteria: stricter, now: NOW });

    const previous = repos.screenings.listEligible(original.criteriaHash);
    assert.equal(previous.length, 1, 'history of what was decided under which rules survives');
  });

  it('detects one description advertised by several companies', () => {
    ingest(repos, discovered());
    ingest(repos, discovered({ companyName: 'Globex', sourceJobId: 'gx-1', sourceName: 'globex' }));
    ingest(repos, discovered({ companyName: 'Initech', sourceJobId: 'it-1', sourceName: 'initech' }));

    const jobs = repos.jobs.list({ limit: 10 });
    assert.equal(jobs.length, 3);

    const job = jobs[0];
    assert.ok(job);
    const screening = screenJob(repos, job, criteria, criteriaHash(criteria), NOW);

    assert.equal(screening.authenticity.provenance, 'suspicious');
    assert.ok(screening.authenticity.signals.some((signal) => signal.code === 'duplicated-across-companies'));
  });

  it('says unknown rather than guessing before enough history exists', () => {
    ingest(repos, discovered(), '2026-09-19T00:00:00.000Z');

    const jobs = repos.jobs.list({ limit: 1 });
    const job = jobs[0];
    assert.ok(job);

    const screening = screenJob(repos, job, criteria, criteriaHash(criteria), NOW);

    assert.equal(screening.authenticity.freshness, 'unknown');
    assert.equal(screening.authenticity.hiringIntent, 'unknown');
  });

  it('does not screen roles that are out of scope', () => {
    ingestJob(repos, discovered({ title: 'Sales Director' }), {
      seenAt: '2026-08-01T00:00:00.000Z',
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
    });

    // Mark it out of scope the way a scan would.
    const job = repos.jobs.list({ limit: 1 })[0];
    assert.ok(job);
    db.prepare('UPDATE jobs SET in_scope = 0 WHERE id = ?').run(job.id);

    const summary = runScreening(repos, { criteria, now: NOW });
    assert.equal(summary.screened, 0, 'out-of-scope roles are history, not candidates');
  });
});
