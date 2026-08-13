import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { parseLeverPostings } from '../../src/discovery/lever.js';
import { ingestJob } from '../../src/discovery/ingest.js';
import { resolveScope } from '../../src/discovery/scope.js';
import { scopeSchema } from '../../src/config/schema.js';
import type { DiscoveredJob } from '../../src/core/types.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function leverJobs(): DiscoveredJob[] {
  return parseLeverPostings(
    JSON.parse(readFileSync(path.join(fixturesDir, 'lever', 'postings.json'), 'utf8')),
    { name: 'shieldai', type: 'lever', enabled: true, company: 'Shield AI', site: 'shieldai' },
  );
}

const SEEN_AT = '2026-08-13T10:00:00.000Z';
const LATER = '2026-08-14T10:00:00.000Z';

const engineeringOnly = resolveScope(scopeSchema.parse({ titles: { include: ['engineer'] } }));

function opts(mode: 'scoped' | 'full' | 'history', when: string, scope = engineeringOnly) {
  return { seenAt: when, scanId: undefined, repostGapDays: 21, captureMode: mode, scope };
}

describe('capture modes', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  it('scoped mode stores only in-scope postings', () => {
    const results = leverJobs().map((job) => ingestJob(repos, job, opts('scoped', SEEN_AT)));

    assert.equal(results.filter((result) => result.outcome === 'skipped').length, 2);
    assert.equal(repos.jobs.count(), 1);
    assert.equal(repos.postings.count(), 1);

    const job = repos.jobs.list({ inScope: true })[0];
    assert.match(job?.title ?? '', /Engineer/i);
  });

  it('full mode stores everything and records the scope decision', () => {
    for (const job of leverJobs()) ingestJob(repos, job, opts('full', SEEN_AT));

    assert.equal(repos.jobs.count(), 3, 'nothing is discarded in full mode');
    assert.equal(repos.jobs.list({ inScope: true }).length, 1);

    const outOfScope = repos.jobs.list({ inScope: false });
    assert.equal(outOfScope.length, 2);
    assert.match(outOfScope[0]?.scopeReason ?? '', /did not match/);
  });

  it('history mode keeps metadata and drops the body', () => {
    for (const job of leverJobs()) ingestJob(repos, job, opts('history', SEEN_AT));

    assert.equal(repos.jobs.count(), 3, 'history mode retains every posting');

    for (const job of repos.jobs.list({ inScope: undefined, limit: 10 })) {
      assert.equal(job.descriptionText, '', 'bodies are not stored in history mode');
      assert.equal(job.hasBody, false);
      assert.ok(job.title.length > 0, 'metadata is still captured');
      assert.equal(repos.snapshots.countForJob(job.id), 0, 'no snapshot without a body');

      const postings = repos.postings.listForJob(job.id);
      assert.equal(postings[0]?.captureMode, 'history');
      assert.ok(postings[0]?.descriptionHash, 'the advertised hash is still recorded');
    }
  });

  it('never lets a bodyless observation erase a stored body', () => {
    const job = leverJobs()[0];
    assert.ok(job);

    const created = ingestJob(repos, job, opts('full', SEEN_AT));
    assert.ok(created.jobId);
    const before = repos.jobs.findById(created.jobId)?.descriptionText.length ?? 0;
    assert.ok(before > 0);

    // The same source is later reconfigured to metadata-only capture.
    ingestJob(repos, { ...job, descriptionHtml: `${job.descriptionHtml}<p>Updated.</p>` }, opts('history', LATER));

    const after = repos.jobs.findById(created.jobId);
    assert.equal(after?.descriptionText.length, before, 'the stored body survives');
    assert.equal(after?.hasBody, true);
  });

  it('backfills a body when a history source is switched to full', () => {
    const job = leverJobs()[0];
    assert.ok(job);

    const created = ingestJob(repos, job, opts('history', SEEN_AT));
    assert.ok(created.jobId);
    assert.equal(repos.jobs.findById(created.jobId)?.descriptionText, '');

    // Same unchanged content, now captured in full: the hashes match, so only
    // the missing-body check can trigger the write.
    ingestJob(repos, job, opts('full', LATER));

    const after = repos.jobs.findById(created.jobId);
    assert.ok((after?.descriptionText.length ?? 0) > 0, 'the body is backfilled');
    assert.equal(after?.hasBody, true);
    assert.equal(repos.snapshots.countForJob(created.jobId), 1, 'the first real body is snapshotted');
  });

  it('keeps refreshing a stored role after it falls out of scope', () => {
    const job = leverJobs().find((entry) => /engineer/i.test(entry.title));
    assert.ok(job);

    const created = ingestJob(repos, job, opts('scoped', SEEN_AT));
    assert.equal(created.outcome, 'new');
    assert.ok(created.jobId);

    const narrower = resolveScope(scopeSchema.parse({ titles: { include: ['quantum'] } }));
    const rescanned = ingestJob(repos, job, opts('scoped', LATER, narrower));

    assert.equal(rescanned.jobId, created.jobId, 'a tracked role is still observed');
    assert.equal(rescanned.inScope, false);

    const stored = repos.jobs.findById(created.jobId);
    assert.equal(stored?.inScope, false, 'the scope decision is recorded');
    assert.equal(stored?.lastSeenAt, LATER, 'last seen keeps advancing');
    assert.equal(stored?.firstSeenAt, SEEN_AT, 'first seen is never rewritten');
  });

  it('is idempotent per capture mode', () => {
    for (const when of [SEEN_AT, LATER]) {
      for (const job of leverJobs()) ingestJob(repos, job, opts('full', when));
    }

    assert.equal(repos.jobs.count(), 3, 'a second scan creates no duplicates');
    assert.equal(repos.postings.count(), 3);
  });

  it('records departments and teams reported by the source', () => {
    const job = leverJobs()[0];
    assert.ok(job);

    const result = ingestJob(repos, job, opts('full', SEEN_AT));
    assert.ok(result.jobId);
    const stored = repos.jobs.findById(result.jobId);

    assert.ok(stored?.department);
    assert.equal(stored?.inScope, true);
  });

  it('defers a new role when the caller withholds permission to add one', () => {
    const job = leverJobs()[0];
    assert.ok(job);

    const deferred = ingestJob(repos, job, { ...opts('full', SEEN_AT), allowNew: false });
    assert.equal(deferred.outcome, 'deferred');
    assert.equal(repos.jobs.count(), 0, 'nothing is recorded, so the next scan sees it again');

    const admitted = ingestJob(repos, job, { ...opts('full', LATER), allowNew: true });
    assert.equal(admitted.outcome, 'new');
    assert.equal(repos.jobs.count(), 1);
  });

  it('still refreshes known postings while new ones are withheld', () => {
    const job = leverJobs()[0];
    assert.ok(job);

    const created = ingestJob(repos, job, opts('full', SEEN_AT));
    const refreshed = ingestJob(repos, job, { ...opts('full', LATER), allowNew: false });

    assert.equal(refreshed.outcome, 'unchanged');
    assert.equal(refreshed.jobId, created.jobId);
    assert.equal(repos.jobs.findById(created.jobId!)?.lastSeenAt, LATER);
  });
});
