import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { parseGreenhouseBoard } from '../../src/discovery/greenhouse.js';
import { ingestJob } from '../../src/discovery/ingest.js';
import type { DiscoveredJob } from '../../src/core/types.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixtureJobs(): DiscoveredJob[] {
  const payload = JSON.parse(readFileSync(path.join(fixturesDir, 'greenhouse', 'board.json'), 'utf8'));
  return parseGreenhouseBoard(payload, {
    name: 'examplecorp',
    type: 'greenhouse',
    enabled: true,
    company: 'Example Corp',
    board: 'examplecorp',
  });
}

const DEFAULTS = { scanId: undefined, repostGapDays: 21 };

describe('ingestion pipeline', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  it('stores fixture jobs with company canonicalization', () => {
    const jobs = fixtureJobs();
    const results = jobs.map((job) => ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-12T10:00:00.000Z' }));

    assert.equal(results.length, 3);
    assert.ok(results.every((result) => result.outcome === 'new'));
    assert.equal(repos.jobs.count(), 3);
    assert.equal(repos.companies.count(), 1);
  });

  it('is idempotent across repeated scans', () => {
    const jobs = fixtureJobs();
    for (const job of jobs) ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-12T10:00:00.000Z' });

    const second = jobs.map((job) => ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-13T10:00:00.000Z' }));

    assert.equal(repos.jobs.count(), 3, 'no duplicate logical jobs');
    assert.ok(second.every((result) => result.outcome === 'unchanged'));

    const first = second[0];
    assert.ok(first);
    assert.ok(first.jobId);
    assert.equal(repos.snapshots.countForJob(first.jobId), 1, 'unchanged content stores one snapshot');
  });

  it('preserves first_seen and advances last_seen', () => {
    const job = fixtureJobs()[0];
    assert.ok(job);

    const created = ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-12T10:00:00.000Z' });
    ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-14T10:00:00.000Z' });

    assert.ok(created.jobId);
    const stored = repos.jobs.findById(created.jobId);
    assert.ok(stored);
    assert.equal(stored.firstSeenAt, '2026-08-12T10:00:00.000Z');
    assert.equal(stored.lastSeenAt, '2026-08-14T10:00:00.000Z');
  });

  it('records a snapshot and a changed event when the description changes', () => {
    const job = fixtureJobs()[0];
    assert.ok(job);

    const created = ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-12T10:00:00.000Z' });

    const edited: DiscoveredJob = {
      ...job,
      descriptionHtml: `${job.descriptionHtml ?? ''}<p>Updated: this team now owns billing too.</p>`,
    };
    const changed = ingestJob(repos, edited, { ...DEFAULTS, seenAt: '2026-08-15T10:00:00.000Z' });

    assert.equal(changed.jobId, created.jobId);
    assert.equal(changed.outcome, 'changed');
    assert.ok(created.jobId);
    assert.equal(repos.snapshots.countForJob(created.jobId), 2, 'old posting body is retained');

    const events = repos.events.listForJob(created.jobId).map((event) => event.eventType);
    assert.deepEqual(events, ['discovered', 'changed']);

    const stored = repos.jobs.findById(created.jobId);
    assert.match(stored?.descriptionText ?? '', /now owns billing/);
  });

  it('records a repost instead of a new job after a long gap', () => {
    const job = fixtureJobs()[0];
    assert.ok(job);

    const created = ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-12T10:00:00.000Z' });
    const later = ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-09-20T10:00:00.000Z' });

    assert.equal(later.jobId, created.jobId);
    assert.equal(later.outcome, 'reposted');
    assert.equal(repos.jobs.count(), 1);

    assert.ok(created.jobId);
    const reposts = repos.events.listRepostsForJob(created.jobId);
    assert.equal(reposts.length, 1);

    const stored = repos.jobs.findById(created.jobId);
    assert.equal(stored?.firstSeenAt, '2026-08-12T10:00:00.000Z', 'original discovery date survives the repost');
  });

  it('treats a new source id for the same posting as a repost, not a new job', () => {
    const job = fixtureJobs()[0];
    assert.ok(job);

    ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-12T10:00:00.000Z' });
    const relisted = ingestJob(
      repos,
      { ...job, sourceJobId: '9999999', url: `${job.url}&gh_src=new` },
      { ...DEFAULTS, seenAt: '2026-08-13T10:00:00.000Z' },
    );

    assert.equal(relisted.outcome, 'reposted');
    assert.equal(relisted.matchedBy, 'source-url');
    assert.equal(repos.jobs.count(), 1);
  });

  it('does not merge different roles at the same company', () => {
    const jobs = fixtureJobs();
    const a = jobs[0];
    const b = jobs[1];
    assert.ok(a && b);

    ingestJob(repos, a, { ...DEFAULTS, seenAt: '2026-08-12T10:00:00.000Z' });
    ingestJob(repos, b, { ...DEFAULTS, seenAt: '2026-08-12T10:00:00.000Z' });

    assert.equal(repos.jobs.count(), 2);
  });

  it('never deletes history when a posting is seen again', () => {
    const job = fixtureJobs()[0];
    assert.ok(job);

    const created = ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-12T10:00:00.000Z' });
    ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-13T10:00:00.000Z' });
    ingestJob(repos, job, { ...DEFAULTS, seenAt: '2026-08-14T10:00:00.000Z' });

    assert.ok(created.jobId);
    assert.equal(repos.events.listForJob(created.jobId).length, 3);
    assert.equal(repos.snapshots.listForJob(created.jobId).length, 1);
  });
});
