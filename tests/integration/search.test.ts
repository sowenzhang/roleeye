import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { ingestJob } from '../../src/discovery/ingest.js';
import { recordApplication, addNote } from '../../src/applications/track.js';
import { syncSearchIndex, indexStats } from '../../src/search/indexer.js';
import { search, toMatchExpression } from '../../src/search/query.js';
import { funnel, segments } from '../../src/analytics/funnel.js';
import { ask, planQuestion, contentWords } from '../../src/search/planner.js';
import type { DiscoveredJob } from '../../src/core/types.js';
import { nowIso } from '../../src/util/time.js';

/**
 * Phase 6: search and analytics.
 *
 * The properties worth protecting are that the index is *derived* — it can
 * always be rebuilt and never disagrees with the records — and that every
 * number reported is computed from rows rather than remembered.
 */

function discovered(index: number, over: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    sourceType: 'greenhouse',
    sourceName: 'nw',
    sourceJobId: `gh-${index}`,
    companyName: 'Northwind Systems',
    title: `Staff Platform Engineer ${index}`,
    location: 'Remote - US',
    url: `https://boards.greenhouse.io/northwind/jobs/${index}`,
    descriptionHtml: `<p>Role ${index}. ${'Design distributed systems on Kubernetes. '.repeat(20)}</p>`,
    ...over,
  };
}

describe('search index', () => {
  let db: Database;
  let repos: Repositories;

  function ingest(index: number, over: Partial<DiscoveredJob> = {}) {
    const result = ingestJob(repos, discovered(index, over), {
      seenAt: '2026-08-14T10:00:00.000Z',
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
    });
    const job = repos.jobs.findById(result.jobId!);
    assert.ok(job);
    return job;
  }

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  it('builds a document per record, and skips what has not changed', () => {
    ingest(1);
    ingest(2);

    const first = syncSearchIndex(db);
    assert.equal(first.documents, 2);
    assert.equal(first.written, 2);

    const second = syncSearchIndex(db);
    assert.equal(second.written, 0, 'an unchanged corpus must cost no writes');
    assert.equal(second.documents, 2);
  });

  it('reindexes a job whose description changed', () => {
    const job = ingest(1);
    syncSearchIndex(db);

    ingestJob(
      repos,
      discovered(1, { descriptionHtml: `<p>Rewritten. ${'Now it is about Postgres replication. '.repeat(20)}</p>` }),
      { seenAt: '2026-08-15T10:00:00.000Z', scanId: undefined, repostGapDays: 21, captureMode: 'full' },
    );

    const stats = syncSearchIndex(db);
    assert.equal(stats.written, 1);

    const hits = search(db, { query: 'postgres replication' }, { skipSync: true }).hits;
    assert.deepEqual(hits.map((hit) => hit.jobId), [job.id]);

    // The old text must not still match: an index that only adds is an index
    // that answers with something that is no longer true.
    assert.equal(search(db, { query: 'kubernetes' }, { skipSync: true }).hits.length, 0);
  });

  it('reindexes a note or a verdict that was edited in place', () => {
    const job = ingest(1);
    addNote(repos, job, 'Recruiter said the team is new.');
    repos.evaluations.save({
      jobId: job.id,
      snapshotId: undefined,
      createdAt: nowIso(),
      decision: 'MAYBE',
      score: 60,
      confidence: 0.6,
      headline: 'unclear scope',
      contentHash: 'c',
      profileHash: 'p',
      criteriaHash: 'k',
      assessment: {},
      skeptic: null,
      scoring: {},
    });

    syncSearchIndex(db);
    assert.equal(syncSearchIndex(db).written, 0);

    // Nothing in the product edits these today. The index must not depend on
    // that staying true: correctness that rests on nobody adding an edit path
    // later is correctness that expires quietly.
    db.prepare(`UPDATE notes SET text = 'Recruiter said the team is being disbanded.'`).run();
    db.prepare(`UPDATE evaluations SET headline = 'scope is a rewrite of the trading ledger'`).run();

    const stats = syncSearchIndex(db);
    assert.equal(stats.written, 2);

    assert.equal(search(db, { query: 'disbanded' }, { skipSync: true }).hits.length, 1);
    assert.equal(search(db, { query: 'trading ledger' }, { skipSync: true }).hits.length, 1);
    assert.equal(search(db, { query: 'unclear scope' }, { skipSync: true }).hits.length, 0);
  });

  it('indexes an application that has no status events yet', () => {
    const job = ingest(1);
    recordApplication(repos, job);
    db.prepare('DELETE FROM application_status_events').run();

    // group_concat over no rows is NULL, and `body` is NOT NULL: without a
    // COALESCE this aborts the entire sync, not just this document.
    assert.doesNotThrow(() => syncSearchIndex(db, { rebuild: true }));
    assert.equal(
      search(db, { documentTypes: ['outcome-summary'] }, { skipSync: true }).hits.length,
      1,
    );
  });

  it('can be dropped and rebuilt to the same state', () => {
    ingest(1);
    ingest(2);
    syncSearchIndex(db);
    const before = indexStats(db);

    const rebuilt = syncSearchIndex(db, { rebuild: true });

    assert.equal(rebuilt.documents, before.documents);
    assert.deepEqual(rebuilt.byType, before.byType);
  });

  it('indexes evaluations, notes, answers and outcomes, not only postings', () => {
    const job = ingest(1);

    repos.evaluations.save({
      jobId: job.id,
      snapshotId: undefined,
      createdAt: nowIso(),
      decision: 'APPLY',
      score: 88,
      confidence: 0.9,
      headline: 'strong platform match',
      contentHash: 'c',
      profileHash: 'p',
      criteriaHash: 'k',
      assessment: { concerns: ['on-call rotation is heavy'] },
      skeptic: null,
      scoring: {},
    });

    addNote(repos, job, 'Recruiter mentioned the team is new.');
    repos.answers.upsert({ questionText: 'Notice period?', answer: 'Four weeks' });
    recordApplication(repos, job);

    const stats = syncSearchIndex(db);
    const types = stats.byType.map((entry) => entry.documentType).sort();

    assert.deepEqual(types, [
      'application-answer',
      'interview-note',
      'job-description',
      'job-evaluation',
      'outcome-summary',
    ]);

    // The reasoning is searchable, not just the verdict.
    const concerns = search(db, { query: 'on-call rotation' }, { skipSync: true }).hits;
    assert.equal(concerns[0]?.documentType, 'job-evaluation');
  });

  it('removes a document whose record is gone', () => {
    const job = ingest(1);
    addNote(repos, job, 'delete me');
    syncSearchIndex(db);

    db.prepare('DELETE FROM notes').run();
    const stats = syncSearchIndex(db);

    assert.equal(stats.removed, 1);
    assert.equal(search(db, { query: 'delete me' }, { skipSync: true }).hits.length, 0);
  });
});

describe('search queries', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  function ingest(index: number, over: Partial<DiscoveredJob> = {}) {
    const result = ingestJob(repos, discovered(index, over), {
      seenAt: '2026-08-14T10:00:00.000Z',
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
    });
    const job = repos.jobs.findById(result.jobId!);
    assert.ok(job);
    return job;
  }

  it('treats user words as words, never as query syntax', () => {
    // FTS5's MATCH language would read these as operators, and a search box
    // that raises a syntax error is a search box people stop using.
    assert.equal(toMatchExpression('senior "staff" engineer (remote)'), '"senior" AND "staff" AND "engineer" AND "remote"');
    assert.equal(toMatchExpression('kubernetes OR postgres'), '"kubernetes" AND "or" AND "postgres"');
    assert.equal(toMatchExpression('   '), undefined);
    assert.equal(toMatchExpression('NEAR(a b)'), '"near" AND "a" AND "b"');
  });

  it('does not throw on input designed to break the query parser', () => {
    ingest(1);

    for (const query of ['"', '*', 'a AND', '^', 'foo:bar', '((((', 'NEAR(', '""""']) {
      assert.doesNotThrow(() => search(db, { query }), `query: ${query}`);
    }
  });

  it('combines a text match with structured filters', () => {
    const kept = ingest(1, { title: 'Staff Platform Engineer, Payments' });
    ingest(2, { title: 'Staff Platform Engineer, Growth', companyName: 'Contoso' });

    repos.evaluations.save({
      jobId: kept.id,
      snapshotId: undefined,
      createdAt: nowIso(),
      decision: 'APPLY',
      score: 90,
      confidence: 0.9,
      headline: 'good',
      contentHash: 'c',
      profileHash: 'p',
      criteriaHash: 'k',
      assessment: {},
      skeptic: null,
      scoring: {},
    });

    const hits = search(db, { query: 'kubernetes', decision: 'APPLY', documentTypes: ['job-description'] }).hits;

    assert.deepEqual(hits.map((hit) => hit.jobId), [kept.id]);
    assert.equal(hits[0]?.decision, 'APPLY');
  });

  it('reports the latest verdict for a role, not every verdict it ever had', () => {
    const job = ingest(1);

    for (const [decision, score, when] of [
      ['SKIP', 20, '2026-08-01T00:00:00.000Z'],
      ['APPLY', 90, '2026-08-10T00:00:00.000Z'],
    ] as const) {
      repos.evaluations.save({
        jobId: job.id,
        snapshotId: undefined,
        createdAt: when,
        decision,
        score,
        confidence: 0.9,
        headline: 'x',
        contentHash: `c${score}`,
        profileHash: 'p',
        criteriaHash: 'k',
        assessment: {},
        skeptic: null,
        scoring: {},
      });
    }

    const hits = search(db, { documentTypes: ['job-description'] }).hits;

    assert.equal(hits.length, 1, 'a role must not be reported once per evaluation');
    assert.equal(hits[0]?.decision, 'APPLY');
  });

  it('finds roles not applied to', () => {
    const applied = ingest(1);
    const untouched = ingest(2);
    recordApplication(repos, applied);

    const hits = search(db, { documentTypes: ['job-description'], applied: false }).hits;

    assert.deepEqual(hits.map((hit) => hit.jobId), [untouched.id]);
  });

  it('hides closed roles unless asked for them', () => {
    const job = ingest(1);
    repos.jobs.close(job.id, nowIso());

    assert.equal(search(db, { documentTypes: ['job-description'] }).hits.length, 0);
    assert.equal(search(db, { documentTypes: ['job-description'], includeClosed: true }).hits.length, 1);
  });
});

describe('analytics', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  function ingest(index: number, over: Partial<DiscoveredJob> = {}) {
    const result = ingestJob(repos, discovered(index, over), {
      seenAt: '2026-08-14T10:00:00.000Z',
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
    });
    const job = repos.jobs.findById(result.jobId!);
    assert.ok(job);
    return job;
  }

  it('counts a stage that was passed through, not only where things ended up', () => {
    const job = ingest(1);
    const { application } = recordApplication(repos, job);

    repos.applications.setStatus(application.id, 'RECRUITER_SCREEN');
    repos.applications.setStatus(application.id, 'INTERVIEWING');
    repos.applications.setStatus(application.id, 'REJECTED');

    const report = funnel(db);

    // Counting current status would report a pipeline in which nobody was ever
    // interviewed, which is the opposite of what happened.
    assert.equal(report.counts.applied, 1);
    assert.equal(report.counts.recruiter_screen, 1);
    assert.equal(report.counts.interviewing, 1);
    assert.equal(report.counts.offer, 0);
  });

  it('reports an unknown rate as unknown, never as zero', () => {
    const report = funnel(db);

    assert.equal(report.counts.applied, 0);
    assert.equal(report.rates.screenRate, undefined);
    assert.equal(report.rates.offerRate, undefined);
  });

  it('is reproducible from the records alone', () => {
    const job = ingest(1);
    recordApplication(repos, job);

    const first = funnel(db);
    const second = funnel(db);

    assert.deepEqual(first.counts, second.counts);
    assert.deepEqual(first.rates, second.rates);
  });

  it('reports the recommendation a window actually contained', () => {
    const job = ingest(1);

    for (const [decision, when] of [
      ['APPLY', '2026-07-10T00:00:00.000Z'],
      ['SKIP', '2026-09-10T00:00:00.000Z'],
    ] as const) {
      repos.evaluations.save({
        jobId: job.id,
        snapshotId: undefined,
        createdAt: when,
        decision,
        score: 70,
        confidence: 0.7,
        headline: 'x',
        contentHash: `c${when}`,
        profileHash: 'p',
        criteriaHash: 'k',
        assessment: {},
        skeptic: null,
        scoring: {},
      });
    }

    // Taking the latest verdict overall and then filtering by date would find
    // September's SKIP, discard it for being outside July, and report that July
    // recommended nothing — rewriting history from a later opinion.
    const july = funnel(db, { since: '2026-07-01T00:00:00.000Z', until: '2026-08-01T00:00:00.000Z' });
    assert.equal(july.counts.recommended, 1);

    const september = funnel(db, { since: '2026-09-01T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z' });
    assert.equal(september.counts.recommended, 0);
  });

  it('counts a role once however many postings or verdicts it has', () => {
    const job = ingest(1);

    for (const when of ['2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z', '2026-08-09T00:00:00.000Z']) {
      repos.evaluations.save({
        jobId: job.id,
        snapshotId: undefined,
        createdAt: when,
        decision: 'APPLY',
        score: 90,
        confidence: 0.9,
        headline: 'x',
        contentHash: `c${when}`,
        profileHash: 'p',
        criteriaHash: 'k',
        assessment: {},
        skeptic: null,
        scoring: {},
      });
    }

    const { application } = recordApplication(repos, job);
    repos.applications.setStatus(application.id, 'INTERVIEWING');
    repos.applications.setStatus(application.id, 'RECRUITER_SCREEN');
    repos.applications.setStatus(application.id, 'INTERVIEWING');

    const report = funnel(db);

    assert.equal(report.counts.evaluated, 1);
    assert.equal(report.counts.recommended, 1);
    assert.equal(report.counts.interviewing, 1, 'reaching a stage twice is still one application');
  });

  it('respects a time window', () => {
    const job = ingest(1);
    recordApplication(repos, job, { appliedAt: '2026-07-04T00:00:00.000Z' });

    const july = funnel(db, { since: '2026-07-01T00:00:00.000Z', until: '2026-08-01T00:00:00.000Z' });
    const august = funnel(db, { since: '2026-08-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' });

    assert.equal(july.counts.applied, 1);
    assert.equal(august.counts.applied, 0);
    assert.equal(august.counts.discovered, 1, 'the role was still discovered in August');
  });

  it('segments outcomes without inventing a salary band', () => {
    const stated = ingest(1);
    const silent = ingest(2, { title: 'Staff Platform Engineer, Silent' });

    db.prepare('UPDATE jobs SET salary_min = 210000 WHERE id = ?').run(stated.id);
    recordApplication(repos, stated);
    recordApplication(repos, silent);

    const rows = segments(db, 'salary_band');
    const bands = Object.fromEntries(rows.map((row) => [row.segment, row.applications]));

    // Most postings state nothing. Folding them into the lowest band would
    // invent a fact about every one of them.
    assert.equal(bands['200k-250k'], 1);
    assert.equal(bands['unstated'], 1);
    assert.equal(bands['under 150k'], undefined);
  });

  it('records both directions of disagreement in the funnel', () => {
    const job = ingest(1);
    repos.evaluations.save({
      jobId: job.id,
      snapshotId: undefined,
      createdAt: nowIso(),
      decision: 'SKIP',
      score: 20,
      confidence: 0.5,
      headline: 'no',
      contentHash: 'c',
      profileHash: 'p',
      criteriaHash: 'k',
      assessment: {},
      skeptic: null,
      scoring: {},
    });

    recordApplication(repos, job);

    const report = funnel(db);
    assert.deepEqual(report.overrides, [{ kind: 'applied_despite_advice', count: 1 }]);
  });
});

describe('query planner', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
    ingestJob(repos, discovered(1), {
      seenAt: '2026-08-14T10:00:00.000Z',
      scanId: undefined,
      repostGapDays: 21,
      captureMode: 'full',
    });
  });

  it('refuses a question about resemblance instead of guessing', () => {
    const answer = ask(db, 'Which roles felt most similar to the Northwind platform role?');

    assert.equal(answer.plan.kind, 'SEMANTIC');
    assert.ok(answer.unanswerable);
    assert.equal(answer.hits.length, 0);
    assert.match(answer.unanswerable, /embeddings/);
  });

  it('routes a count to analytics and a phrase to the text index', () => {
    assert.equal(planQuestion(db, 'How many roles did I apply to in July?').kind, 'ANALYTICS');
    assert.equal(planQuestion(db, 'What percentage of applications got a recruiter screen?').kind, 'ANALYTICS');
    assert.equal(planQuestion(db, 'kubernetes operators').kind, 'KEYWORD');
  });

  it('lets a constraint consume its own words', () => {
    const plan = planQuestion(db, 'When did I apply to Northwind Systems?');

    // Leaving "northwind" in the text query would also demand the word appear
    // in the body, and FTS requires every term.
    assert.equal(plan.kind, 'STRUCTURED');
    assert.equal(plan.filters.company, 'Northwind Systems');
    assert.equal(plan.filters.query, undefined);
  });

  it('reads a month as a window over the record', () => {
    const plan = planQuestion(db, 'What AI roles did I see in July 2026 but skip?', new Date('2026-08-14T00:00:00Z'));

    assert.equal(plan.filters.since, '2026-07-01T00:00:00.000Z');
    assert.equal(plan.filters.until, '2026-08-01T00:00:00.000Z');
    assert.equal(plan.filters.applied, false);
    assert.equal(plan.kind, 'HYBRID');
  });

  it('does not read a word inside another word as a company or a decision', () => {
    // "ramp-up" is not Ramp, and a role that skips a technical screen is not a
    // role the user skipped. Both silently emptied the result set.
    const plan = planQuestion(db, 'How many roles skip the ramp-up period at Northwind Systems?');

    assert.equal(plan.filters.applied, undefined);

    const other = planQuestion(db, 'Which roles skip the technical screen?');
    assert.equal(other.filters.applied, undefined);
    assert.equal(other.filters.company, undefined);

    const deliberate = planQuestion(db, 'What did I see in July but skip?');
    assert.equal(deliberate.filters.applied, false);
  });

  it('matches a company only against companies that exist', () => {
    // "Staff Engineer" is a title, not an employer, and guessing from
    // capitalisation would treat it as one.
    assert.equal(planQuestion(db, 'Which Staff Engineer roles did I see?').filters.company, undefined);
    assert.equal(planQuestion(db, 'Anything from Northwind Systems?').filters.company, 'Northwind Systems');
  });

  it('always names the command that reproduces the answer', () => {
    for (const question of [
      'How many did I apply to?',
      'kubernetes',
      'When did I apply to Northwind Systems?',
      'Which roles felt similar to that one?',
    ]) {
      assert.ok(planQuestion(db, question).equivalent.startsWith('roleeye '), question);
    }
  });

  it('drops question words that would match everything', () => {
    assert.deepEqual(contentWords('Which roles did I see in July?'), []);
    assert.deepEqual(contentWords('kubernetes operators at scale'), ['kubernetes', 'operators', 'scale']);
  });
});
