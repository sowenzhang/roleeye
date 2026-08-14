import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { largeRunWarning, rankForEvaluation, scoreJob } from '../../src/evaluate/priority.js';
import type { Screening } from '../../src/db/repositories/screenings.js';
import type { JobRecord } from '../../src/db/repositories/jobs.js';

const NOW = Date.parse('2026-08-13T00:00:00.000Z');

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job_1',
    companyName: 'Northwind',
    title: 'Staff Engineer',
    workArrangement: 'remote',
    descriptionText: 'Build event-driven services. '.repeat(30),
    descriptionHash: 'h',
    postedAt: '2026-08-10T00:00:00.000Z',
    firstSeenAt: '2026-08-10T00:00:00.000Z',
    ...over,
  } as JobRecord;
}

function screening(over: Partial<Screening['authenticity']> = {}, warnings: unknown[] = []): Screening {
  return {
    id: 's1',
    jobId: 'job_1',
    screenedAt: '2026-08-12T00:00:00.000Z',
    criteriaHash: 'c',
    eligible: true,
    rejections: [],
    warnings: warnings as Screening['warnings'],
    authenticity: {
      freshness: 'current',
      hiringIntent: 'specific',
      fraudRisk: 'low',
      provenance: 'verified',
      signals: [],
      blocked: false,
      ...over,
    },
  };
}

describe('evaluation priority', () => {
  it('prefers a fresh, specific role over an evergreen one', () => {
    const good = scoreJob(job({ id: 'a' }), screening(), NOW);
    const evergreen = scoreJob(job({ id: 'b' }), screening({ hiringIntent: 'evergreen' }), NOW);

    assert.ok(good.priority > evergreen.priority);
    assert.match(evergreen.reason, /evergreen/);
  });

  it('demotes a role with an unstated salary, and says why', () => {
    const stated = scoreJob(job({ id: 'a', salaryMin: 200_000 }), screening(), NOW);
    const silent = scoreJob(job({ id: 'b' }), screening(), NOW);

    assert.ok(stated.priority > silent.priority, 'a stated salary removes the commonest unknown');
    assert.match(silent.reason, /no stated pay/);
  });

  it('demotes anything the screener flagged', () => {
    const clean = scoreJob(job({ id: 'a' }), screening(), NOW);
    const flagged = scoreJob(job({ id: 'b' }), screening({ fraudRisk: 'medium' }, [{ rule: 'x' }, { rule: 'y' }]), NOW);

    assert.ok(clean.priority > flagged.priority);
    assert.match(flagged.reason, /fraud risk/);
    assert.match(flagged.reason, /2 warning/);
  });

  it('ranks an unscreened role below a screened clean one', () => {
    const [first, second] = rankForEvaluation(
      [job({ id: 'unscreened' }), job({ id: 'screened' })],
      (id) => (id === 'screened' ? screening() : undefined),
      NOW,
    );

    assert.equal(first?.job.id, 'screened');
    assert.match(second!.reason, /not screened/);
  });

  it('orders reproducibly when priorities tie', () => {
    const jobs = [job({ id: 'b' }), job({ id: 'a' })];
    const once = rankForEvaluation(jobs, () => screening(), NOW).map((entry) => entry.job.id);
    const twice = rankForEvaluation([...jobs].reverse(), () => screening(), NOW).map((entry) => entry.job.id);

    assert.deepEqual(once, twice, 'the same input must produce the same run every day');
  });
});

describe('long run warning', () => {
  it('says nothing at or below twenty', () => {
    assert.equal(largeRunWarning(20, 7), undefined);
    assert.equal(largeRunWarning(5, 7), undefined);
  });

  it('states the measured time rather than scolding', () => {
    const warning = largeRunWarning(40, 7)!;

    assert.match(warning, /40 roles/);
    assert.match(warning, /4\.7 hours/, 'the number is what makes the point');
    assert.ok(!/should|too many|bad idea/i.test(warning));
  });

  it('has no maximum, only a warning', () => {
    assert.ok(largeRunWarning(500, 7), 'a large number is allowed, and explained');
  });
});
