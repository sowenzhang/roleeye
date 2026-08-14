import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase, type Database } from '../../src/db/database.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { ingestJob } from '../../src/discovery/ingest.js';
import { addNote, recordApplication, skipRole, pipelineSummary } from '../../src/applications/track.js';
import { isSensitiveQuestion, questionKey } from '../../src/db/repositories/answers.js';
import type { DiscoveredJob } from '../../src/core/types.js';
import { nowIso } from '../../src/util/time.js';

/**
 * Phase 5: what the user actually did, and what it led to.
 *
 * The tests that matter here are about *history* and *disagreement*. A tracker
 * that overwrites its own past, or that quietly discards the times the user
 * ignored the advice, cannot answer the only question worth asking six months
 * later: was any of this working?
 */

function discovered(over: Partial<DiscoveredJob> = {}): DiscoveredJob {
  return {
    sourceType: 'greenhouse',
    sourceName: 'nw',
    sourceJobId: 'gh-1',
    companyName: 'Northwind Systems',
    title: 'Staff Platform Engineer',
    location: 'Remote - US',
    url: 'https://boards.greenhouse.io/nw/jobs/1',
    descriptionHtml: `<p>Build things. ${'Design distributed systems. '.repeat(20)}</p>`,
    ...over,
  };
}

describe('application tracking', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  function ingest(index = 1) {
    const result = ingestJob(
      repos,
      discovered({
        sourceJobId: `gh-${index}`,
        url: `https://boards.greenhouse.io/nw/jobs/${index}`,
        // Distinct bodies: identical text under one company clusters into a
        // single logical role, which is correct and would make this fixture
        // quietly test one job twice.
        descriptionHtml: `<p>Role ${index}. ${'Design distributed systems. '.repeat(20)}</p>`,
      }),
      {
        seenAt: '2026-08-14T10:00:00.000Z',
        scanId: undefined,
        repostGapDays: 21,
        captureMode: 'full',
      },
    );
    assert.ok(result.jobId);
    const job = repos.jobs.findById(result.jobId);
    assert.ok(job);
    return job;
  }

  function evaluate(jobId: string, decision: 'APPLY' | 'MAYBE' | 'SKIP', score = 80) {
    return repos.evaluations.save({
      jobId,
      snapshotId: undefined,
      createdAt: nowIso(),
      decision,
      score,
      confidence: 0.8,
      headline: 'looks plausible',
      contentHash: 'c',
      profileHash: 'p',
      criteriaHash: 'k',
      assessment: {},
      skeptic: null,
      scoring: {},
    });
  }

  it('records an application with the resume that went with it', () => {
    const job = ingest();
    evaluate(job.id, 'APPLY', 91);

    const result = recordApplication(repos, job, { referral: 'Dana', note: 'applied via referral' });

    assert.equal(result.application.currentStatus, 'APPLIED');
    assert.equal(result.application.referral, 'Dana');
    assert.equal(result.advice.decision, 'APPLY');
    assert.equal(result.advice.score, 91);
    assert.equal(result.overrode, false);
    // The advice is frozen at the moment of applying, so a later re-score
    // cannot rewrite what the user was told.
    assert.equal(result.application.decisionAtApply, 'APPLY');
    assert.equal(result.application.scoreAtApply, 91);
  });

  it('keeps every state it has ever been in', () => {
    const job = ingest();
    const { application } = recordApplication(repos, job);

    repos.applications.setStatus(application.id, 'RECRUITER_SCREEN', { note: 'call booked' });
    repos.applications.setStatus(application.id, 'INTERVIEWING');
    repos.applications.setStatus(application.id, 'REJECTED', { note: 'no headcount' });

    const history = repos.applications.history(application.id);

    assert.deepEqual(
      history.map((event) => event.toStatus),
      ['APPLIED', 'RECRUITER_SCREEN', 'INTERVIEWING', 'REJECTED'],
    );
    assert.equal(history[1]?.fromStatus, 'APPLIED');
    assert.equal(history[3]?.notes, 'no headcount');
    assert.equal(repos.applications.get(application.id)?.currentStatus, 'REJECTED');
    assert.ok(repos.applications.get(application.id)?.closedAt, 'a rejection closes the application');
  });

  it('treats re-recording as a correction, not a second application', () => {
    const job = ingest();
    recordApplication(repos, job);
    recordApplication(repos, job, { url: 'https://example.com/apply/42' });

    assert.equal(repos.applications.list({}).length, 1);
    assert.equal(repos.applications.findByJob(job.id)?.applicationUrl, 'https://example.com/apply/42');
  });

  describe('disagreement is the point', () => {
    it('records applying against the advice', () => {
      const job = ingest();
      evaluate(job.id, 'SKIP', 30);

      const result = recordApplication(repos, job, { reason: 'I know the hiring manager' });

      assert.equal(result.overrode, true);
      const feedback = repos.applications.feedbackForJob(job.id);
      assert.equal(feedback[0]?.kind, 'applied_despite_advice');
      assert.equal(feedback[0]?.decision, 'SKIP');
      assert.equal(feedback[0]?.reason, 'I know the hiring manager');
    });

    it('records passing on something it recommended', () => {
      // The half most tools throw away.
      const job = ingest();
      evaluate(job.id, 'APPLY', 88);

      const result = skipRole(repos, job, { reason: 'commute' });

      assert.equal(result.overrode, true);
      assert.equal(repos.applications.feedbackForJob(job.id)[0]?.kind, 'skipped_despite_advice');
    });

    it('records agreement too, so the ratio means something', () => {
      const job = ingest();
      evaluate(job.id, 'APPLY', 88);
      recordApplication(repos, job);

      assert.equal(repos.applications.feedbackForJob(job.id)[0]?.kind, 'agreed');
      assert.deepEqual(
        repos.applications.feedbackSummary().map((entry) => entry.kind),
        ['agreed'],
      );
    });
  });

  it('counts roles it recommended that have had no decision', () => {
    const recommended = ingest(1);
    const applied = ingest(2);
    evaluate(recommended.id, 'APPLY', 90);
    evaluate(applied.id, 'APPLY', 90);
    recordApplication(repos, applied);

    const summary = pipelineSummary(repos);

    assert.equal(summary.open, 1);
    assert.equal(summary.awaitingDecision, 1);
  });

  it('keeps notes against the role and the application', () => {
    const job = ingest();
    recordApplication(repos, job);
    addNote(repos, job, 'Recruiter mentioned the team is new.');

    const notes = repos.notes.listForJob(job.id);
    assert.equal(notes.length, 1);
    assert.ok(notes[0]?.applicationId, 'the note is attached to the application when one exists');
  });
});

describe('application answers', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    repos = createRepositories(db);
  });

  it('recognises protected questions however they are worded', () => {
    for (const question of [
      'Will you now or in the future require visa sponsorship?',
      'Do you have the right to work in the UK?',
      'What are your salary expectations?',
      'Are you a protected veteran?',
    ]) {
      assert.equal(isSensitiveQuestion(question), true, question);
    }

    assert.equal(isSensitiveQuestion('What is your notice period?'), false);
  });

  it('gives two phrasings of the same question one key', () => {
    assert.equal(
      questionKey('Will you now or in the future require sponsorship?'),
      questionKey('Do you now or in the future require sponsorship'),
    );
  });

  it('reports a protected question with no answer instead of inferring one', () => {
    // The rule from the phase acceptance criteria: never filled from a
    // similar previous answer.
    repos.answers.upsert({
      questionText: 'Do you have the right to work in Canada?',
      answer: 'Yes, citizen',
      scope: 'jurisdiction',
      scopeValue: 'CA',
    });

    const lookup = repos.answers.lookup('Do you require visa sponsorship in Germany?', { jurisdiction: 'DE' });

    assert.equal(lookup.status, 'blocked-sensitive');
    assert.equal(lookup.answer, undefined);
  });

  it('prefers an employer-specific answer over a universal one', () => {
    repos.answers.upsert({ questionText: 'Why do you want to work here?', answer: 'I like the mission.' });
    repos.answers.upsert({
      questionText: 'Why do you want to work here?',
      answer: 'Your payments platform is the problem I want next.',
      scope: 'employer',
      scopeValue: 'Northwind',
    });

    const lookup = repos.answers.lookup('Why do you want to work here?', { employer: 'Northwind' });

    assert.equal(lookup.status, 'ready');
    assert.match(lookup.answer?.answer ?? '', /payments platform/);
  });

  it('withholds a protected answer until it is confirmed for this application', () => {
    repos.answers.upsert({ questionText: 'What are your salary expectations?', answer: '200000 USD' });

    const before = repos.answers.lookup('What are your salary expectations?');
    assert.equal(before.status, 'needs-confirmation');

    repos.answers.confirm(before.answer?.id as string);

    assert.equal(repos.answers.lookup('What are your salary expectations?').status, 'ready');
  });

  it('refuses an answer that has expired', () => {
    repos.answers.upsert({
      questionText: 'What is your notice period?',
      answer: 'Four weeks',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    assert.equal(repos.answers.lookup('What is your notice period?').status, 'expired');
  });

  it('says plainly when it simply does not know', () => {
    assert.equal(repos.answers.lookup('How did you hear about us?').status, 'unanswered');
  });
});
