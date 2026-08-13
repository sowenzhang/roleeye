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

/** Keeps only engineering titles, which the fixture satisfies for one posting. */
const engineeringOnly = resolveScope(scopeSchema.parse({ titles: { include: ['engineer'] } }));

describe('capture modes', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  it('scoped mode stores only in-scope postings', () => {
    const results = leverJobs().map((job) =>
      ingestJob(repos, job, {
        seenAt: SEEN_AT,
        scanId: undefined,
        repostGapDays: 21,
        captureMode: 'scoped',
        scope: engineeringOnly,
      }),
    );

    const stored = results.filter((result) => result !== undefined);
    assert.equal(stored.length, 1, 'only the engineering posting is stored');
    assert.equal(repos.jobs.count(), 1);

    const job = repos.jobs.list({ inScope: true })[0];
    assert.match(job?.title ?? '', /Engineer/i);
    assert.equal(job?.captureMode, 'scoped');
    assert.equal(job?.inScope, true);
  });

  it('full mode stores everything and records the scope decision', () => {
    for (const job of leverJobs()) {
      ingestJob(repos, job, {
        seenAt: SEEN_AT,
        scanId: undefined,
        repostGapDays: 21,
        captureMode: 'full',
        scope: engineeringOnly,
      });
    }

    assert.equal(repos.jobs.count(), 3, 'nothing is discarded in full mode');

    const inScope = repos.jobs.list({ inScope: true });
    const outOfScope = repos.jobs.list({ inScope: false });

    assert.equal(inScope.length, 1);
    assert.equal(outOfScope.length, 2);
    assert.match(outOfScope[0]?.scopeReason ?? '', /did not match/);
  });

  it('history mode keeps metadata and drops the body', () => {
    for (const job of leverJobs()) {
      ingestJob(repos, job, {
        seenAt: SEEN_AT,
        scanId: undefined,
        repostGapDays: 21,
        captureMode: 'history',
        scope: engineeringOnly,
      });
    }

    assert.equal(repos.jobs.count(), 3, 'history mode retains every posting');

    for (const job of repos.jobs.list({ inScope: undefined, limit: 10 })) {
      assert.equal(job.descriptionText, '', 'bodies are not stored in history mode');
      assert.equal(job.captureMode, 'history');
      assert.ok(job.title.length > 0, 'metadata is still captured');
      assert.equal(repos.snapshots.countForJob(job.id), 0, 'no snapshot without a body');
    }
  });

  it('records departments and teams reported by the source', () => {
    const job = leverJobs()[0];
    assert.ok(job);

    const result = ingestJob(repos, job, {
      seenAt: SEEN_AT,
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
      scope: undefined,
    });

    assert.ok(result);
    const stored = repos.jobs.findById(result.jobId);
    assert.ok(stored?.department);
    assert.equal(stored?.inScope, true);
  });

  it('filters by department through the repository', () => {
    for (const job of leverJobs()) {
      ingestJob(repos, job, {
        seenAt: SEEN_AT,
        scanId: undefined,
        repostGapDays: 21,
        captureMode: 'full',
        scope: undefined,
      });
    }

    const department = repos.jobs.list({ limit: 5 })[0]?.department;
    assert.ok(department);

    const matched = repos.jobs.list({ department: department.slice(0, 6) });
    assert.ok(matched.length >= 1);
  });

  it('keeps history when a role later falls out of scope', () => {
    const job = leverJobs().find((entry) => /engineer/i.test(entry.title));
    assert.ok(job);

    const created = ingestJob(repos, job, {
      seenAt: SEEN_AT,
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
      scope: engineeringOnly,
    });
    assert.ok(created);

    // The user narrows their scope; the stored role must survive as history.
    const narrower = resolveScope(scopeSchema.parse({ titles: { include: ['quantum'] } }));
    const rescanned = ingestJob(repos, job, {
      seenAt: '2026-08-14T10:00:00.000Z',
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
      scope: narrower,
    });

    assert.ok(rescanned);
    assert.equal(rescanned.jobId, created.jobId);
    assert.equal(rescanned.inScope, false);

    const stored = repos.jobs.findById(created.jobId);
    assert.ok(stored, 'the job still exists');
    assert.equal(stored.inScope, false);
    assert.equal(stored.firstSeenAt, SEEN_AT, 'first seen is never rewritten');
    assert.equal(repos.events.listForJob(created.jobId).length, 2, 'history is intact');
  });

  it('is idempotent per capture mode', () => {
    const jobs = leverJobs();
    for (const round of [0, 1]) {
      for (const job of jobs) {
        ingestJob(repos, job, {
          seenAt: round === 0 ? SEEN_AT : '2026-08-14T10:00:00.000Z',
          scanId: undefined,
          repostGapDays: 21,
          captureMode: 'full',
          scope: engineeringOnly,
        });
      }
    }

    assert.equal(repos.jobs.count(), 3, 'a second scan creates no duplicates');
  });
});
