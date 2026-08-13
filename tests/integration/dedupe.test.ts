import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { ingestJob } from '../../src/discovery/ingest.js';
import type { DiscoveredJob } from '../../src/core/types.js';

/**
 * The reason migration 003 exists: one role advertised by several sources must
 * be one role with several postings, not one row whose identity keeps changing.
 */

const BODY =
  '<p>We are hiring a Staff Platform Engineer to build event-driven services.</p>' +
  '<ul><li>Design distributed systems</li><li>Partner with product teams</li></ul>';

function greenhouse(over: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    sourceType: 'greenhouse',
    sourceName: 'acme-greenhouse',
    sourceJobId: 'gh-1',
    companyName: 'Acme',
    title: 'Staff Platform Engineer',
    location: 'Seattle, WA',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    descriptionHtml: BODY,
    ...over,
  };
}

function lever(over: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    sourceType: 'lever',
    sourceName: 'acme-lever',
    sourceJobId: 'lv-9',
    companyName: 'Acme',
    title: 'Staff Platform Engineer',
    location: 'Seattle, WA',
    url: 'https://jobs.lever.co/acme/9',
    descriptionHtml: BODY,
    ...over,
  };
}

const DAY1 = '2026-08-13T10:00:00.000Z';
const DAY2 = '2026-08-14T10:00:00.000Z';
const DAY3 = '2026-08-15T10:00:00.000Z';

function ingest(repos: Repositories, job: DiscoveredJob, when: string) {
  return ingestJob(repos, job, { seenAt: when, scanId: undefined, repostGapDays: 21, captureMode: 'full' });
}

describe('cross-source deduplication', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  it('treats the same role on two providers as one role with two postings', () => {
    const first = ingest(repos, greenhouse(), DAY1);
    const second = ingest(repos, lever(), DAY1);

    assert.equal(second.jobId, first.jobId, 'both postings belong to one role');
    assert.equal(second.clusteredBy, 'cluster-key');
    assert.equal(repos.jobs.count(), 1);
    assert.equal(repos.postings.count(), 2);

    const postings = repos.postings.listForJob(first.jobId!);
    assert.deepEqual(
      postings.map((posting) => posting.sourceType).sort(),
      ['greenhouse', 'lever'],
      'each provider keeps its own identity',
    );
  });

  it('does not report a repost when two providers alternate', () => {
    ingest(repos, greenhouse(), DAY1);
    ingest(repos, lever(), DAY1);

    // Several scans of both boards, exactly as a daily schedule would run.
    for (const when of [DAY2, DAY3]) {
      ingest(repos, greenhouse(), when);
      ingest(repos, lever(), when);
    }

    const jobId = repos.jobs.list({ limit: 1 })[0]?.id;
    assert.ok(jobId);

    const reposts = repos.events.listRepostsForJob(jobId);
    assert.equal(reposts.length, 0, 'alternating sources must not look like reposting');
  });

  it('still detects a genuine repost within one source', () => {
    const created = ingest(repos, greenhouse(), DAY1);

    // Same source, same URL, new requisition id.
    const relisted = ingest(repos, greenhouse({ sourceJobId: 'gh-2' }), DAY2);

    assert.equal(relisted.jobId, created.jobId);
    assert.equal(relisted.outcome, 'reposted');
    assert.equal(relisted.matchedBy, 'source-url');
    assert.equal(repos.postings.count(), 1, 'the reissued requisition is the same posting');
  });

  it('clusters multi-location listings of one role', () => {
    const seattle = ingest(repos, greenhouse({ sourceJobId: 'gh-1', location: 'Seattle, WA' }), DAY1);
    const austin = ingest(
      repos,
      greenhouse({ sourceJobId: 'gh-2', url: 'https://boards.greenhouse.io/acme/jobs/2', location: 'Austin, TX' }),
      DAY1,
    );

    assert.equal(austin.jobId, seattle.jobId, 'one role, advertised in two locations');
    assert.equal(repos.postings.count(), 2);

    const locations = repos.postings.listForJob(seattle.jobId!).map((posting) => posting.locationText);
    assert.deepEqual(locations.sort(), ['Austin, TX', 'Seattle, WA']);
  });

  it('never merges different roles at the same company', () => {
    ingest(repos, greenhouse(), DAY1);
    ingest(
      repos,
      greenhouse({
        sourceJobId: 'gh-77',
        url: 'https://boards.greenhouse.io/acme/jobs/77',
        title: 'Staff Platform Engineer',
        descriptionHtml: '<p>Completely different responsibilities on another team entirely.</p>',
      }),
      DAY1,
    );

    assert.equal(repos.jobs.count(), 2, 'identical titles are not enough to merge');
  });

  it('never merges identical postings from different companies', () => {
    ingest(repos, greenhouse(), DAY1);
    ingest(repos, greenhouse({ companyName: 'Globex', sourceJobId: 'gx-1', sourceName: 'globex' }), DAY1);

    assert.equal(repos.jobs.count(), 2);
  });

  it('does not cluster on an empty body', () => {
    const a = ingestJob(repos, greenhouse({ descriptionHtml: undefined }), {
      seenAt: DAY1,
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
    });
    const b = ingestJob(repos, lever({ descriptionHtml: undefined }), {
      seenAt: DAY1,
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
    });

    assert.notEqual(b.jobId, a.jobId, 'two empty bodies are not evidence of the same role');
    assert.equal(repos.jobs.count(), 2);
  });

  it('adopts a body from a second source when the first had none', () => {
    const historyOnly = ingestJob(repos, greenhouse(), {
      seenAt: DAY1,
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'history',
    });
    assert.equal(repos.jobs.findById(historyOnly.jobId!)?.hasBody, false);

    const withBody = ingest(repos, lever(), DAY2);

    assert.equal(withBody.jobId, historyOnly.jobId, 'the metadata-only role gains a second source');
    const job = repos.jobs.findById(historyOnly.jobId!);
    assert.equal(job?.hasBody, true, 'the body arrives with the source that carries one');
    assert.ok((job?.descriptionText.length ?? 0) > 0);
  });
});

describe('posting closure', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  it('closes a posting a source stopped advertising', () => {
    const created = ingest(repos, greenhouse(), DAY1);
    assert.ok(created.jobId);

    // A later successful run of the same source no longer lists it.
    const closed = repos.postings.closeMissing('acme-greenhouse', DAY2, DAY2);
    assert.equal(closed.length, 1);

    for (const jobId of repos.postings.jobIdsWithAllPostingsClosed(closed)) {
      repos.jobs.close(jobId, DAY2);
    }

    const job = repos.jobs.findById(created.jobId);
    assert.equal(job?.closedAt, DAY2);
    assert.equal(repos.jobs.list({ limit: 10 }).length, 0, 'closed roles leave the default listing');
    assert.equal(repos.jobs.list({ limit: 10, includeClosed: true }).length, 1, 'but remain queryable as history');
  });

  it('keeps a role open while any source still advertises it', () => {
    const created = ingest(repos, greenhouse(), DAY1);
    ingest(repos, lever(), DAY1);

    // Only the greenhouse board dropped it.
    ingest(repos, lever(), DAY2);
    const closed = repos.postings.closeMissing('acme-greenhouse', DAY2, DAY2);

    assert.equal(closed.length, 1);
    assert.deepEqual(repos.postings.jobIdsWithAllPostingsClosed(closed), [], 'the lever posting is still live');
    assert.equal(repos.jobs.findById(created.jobId!)?.closedAt, undefined);
  });

  it('reopens a posting that comes back', () => {
    const created = ingest(repos, greenhouse(), DAY1);
    const closed = repos.postings.closeMissing('acme-greenhouse', DAY2, DAY2);
    for (const jobId of repos.postings.jobIdsWithAllPostingsClosed(closed)) repos.jobs.close(jobId, DAY2);

    const returned = ingest(repos, greenhouse(), DAY3);

    assert.equal(returned.jobId, created.jobId);
    assert.equal(returned.outcome, 'reposted', 'returning after closure is a repost');
    assert.equal(repos.jobs.findById(created.jobId!)?.closedAt, undefined, 'the role is open again');
    assert.equal(repos.postings.listForJob(created.jobId!)[0]?.closedAt, undefined);
  });

  it('does not close a posting seen during the current scan', () => {
    ingest(repos, greenhouse(), DAY2);
    const closed = repos.postings.closeMissing('acme-greenhouse', DAY1, DAY2);
    assert.equal(closed.length, 0);
  });
});
