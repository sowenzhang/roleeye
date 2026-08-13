import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { criteriaSchema } from '../../src/config/schema.js';
import { applyHardFilters } from '../../src/evaluate/hard-filters.js';
import { canonicalize, criteriaHash, deniedApplicationSystems } from '../../src/evaluate/criteria.js';
import type { JobRecord } from '../../src/db/repositories/jobs.js';
import type { SourcePosting } from '../../src/db/repositories/source-postings.js';

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job_1',
    companyId: 'co_1',
    companyName: 'Acme',
    title: 'Staff Engineer',
    normalizedTitle: 'staff engineer',
    level: 'staff',
    employmentType: 'full-time',
    workArrangement: 'onsite',
    locationText: 'Seattle, WA',
    country: 'US',
    department: 'Engineering',
    team: undefined,
    salaryMin: 200_000,
    salaryMax: 250_000,
    salaryCurrency: 'USD',
    salaryPeriod: 'year',
    descriptionText: 'Build things with a team.',
    descriptionHash: 'hash',
    hasBody: true,
    fingerprint: 'fp',
    clusterKey: 'ck',
    inScope: true,
    scopeReason: undefined,
    postedAt: undefined,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-13T00:00:00.000Z',
    closedAt: undefined,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...over,
  };
}

function posting(over: Partial<SourcePosting> = {}): SourcePosting {
  return {
    id: 'post_1',
    jobId: 'job_1',
    sourceType: 'greenhouse',
    sourceName: 'acme',
    sourceJobId: '1',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    applicationSystem: 'greenhouse',
    identityKey: 'src:greenhouse:1',
    identityTier: 'source-id',
    locationText: 'Seattle, WA',
    captureMode: 'scoped',
    descriptionHash: 'hash',
    hasBody: true,
    postedAt: undefined,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-13T00:00:00.000Z',
    closedAt: undefined,
    ...over,
  };
}

function criteria(overrides: Record<string, unknown> = {}) {
  return criteriaSchema.parse(overrides);
}

describe('criteria hashing', () => {
  it('ignores key order and formatting', () => {
    const a = criteria({ hard_filters: { countries: ['US'], require_us_payroll: true } });
    const b = criteria({ hard_filters: { require_us_payroll: true, countries: ['US'] } });
    assert.equal(criteriaHash(a), criteriaHash(b));
  });

  it('changes when a decision-relevant value changes', () => {
    const base = criteria({ hard_filters: { minimum_base_salary: { amount: 200_000, currency: 'USD' } } });
    const raised = criteria({ hard_filters: { minimum_base_salary: { amount: 220_000, currency: 'USD' } } });
    assert.notEqual(criteriaHash(base), criteriaHash(raised));
  });

  it('does not change when a cosmetic field changes', () => {
    const a = criteria({ profile_name: 'default' });
    const b = criteria({ profile_name: 'renamed' });
    assert.equal(criteriaHash(a), criteriaHash(b), 'a profile rename must not invalidate every cached verdict');
  });

  it('canonicalizes nested structures', () => {
    assert.deepEqual(canonicalize({ b: 1, a: [{ d: 2, c: 3 }] }), { a: [{ c: 3, d: 2 }], b: 1 });
  });

  it('reads denied application systems from both places a user can state them', () => {
    const config = criteria({
      preferences: { application_system: { deny: ['Workday'] } },
      penalties: { application_system: { icims: -100, taleo: -20 } },
    });

    const denied = deniedApplicationSystems(config);
    assert.ok(denied.includes('workday'));
    assert.ok(denied.includes('icims'), 'a -100 penalty is a rejection stated differently');
    assert.ok(!denied.includes('taleo'), 'a smaller penalty is not a rejection');
  });
});

describe('hard filters', () => {
  it('passes a role that satisfies everything', () => {
    const verdict = applyHardFilters(
      { job: job(), postings: [posting()] },
      criteria({ hard_filters: { countries: ['US'], minimum_base_salary: { amount: 200_000, currency: 'USD' } } }),
    );

    assert.equal(verdict.eligible, true);
    assert.equal(verdict.rejections.length, 0);
  });

  it('rejects on country and names the rule', () => {
    const verdict = applyHardFilters(
      { job: job({ country: 'DE' }), postings: [posting()] },
      criteria({ hard_filters: { countries: ['US'] } }),
    );

    assert.equal(verdict.eligible, false);
    assert.equal(verdict.rejections[0]?.rule, 'country');
    assert.match(verdict.rejections[0]?.detail ?? '', /DE is not in US/);
  });

  it('does not reject a remote role for having no stated country', () => {
    const verdict = applyHardFilters(
      { job: job({ country: undefined, workArrangement: 'remote' }), postings: [posting()] },
      criteria({ hard_filters: { countries: ['US'] } }),
    );

    assert.equal(verdict.eligible, true);
  });

  it('rejects below the salary floor using the top of the range', () => {
    const verdict = applyHardFilters(
      { job: job({ salaryMin: 120_000, salaryMax: 150_000 }), postings: [posting()] },
      criteria({ hard_filters: { minimum_base_salary: { amount: 200_000, currency: 'USD' } } }),
    );

    assert.equal(verdict.eligible, false);
    assert.equal(verdict.rejections[0]?.rule, 'salary');
  });

  it('normalizes hourly pay before comparing', () => {
    const verdict = applyHardFilters(
      {
        job: job({ salaryMin: 120, salaryMax: 130, salaryPeriod: 'hour' }),
        postings: [posting()],
      },
      criteria({ hard_filters: { minimum_base_salary: { amount: 200_000, currency: 'USD' } } }),
    );

    // 130/hour is about 270k a year, comfortably above the floor.
    assert.equal(verdict.eligible, true);
  });

  it('treats missing salary according to the configured policy', () => {
    const noSalary = { job: job({ salaryMin: undefined, salaryMax: undefined }), postings: [posting()] };
    const threshold = { minimum_base_salary: { amount: 200_000, currency: 'USD' } };

    const flagged = applyHardFilters(noSalary, criteria({ hard_filters: { ...threshold } }));
    assert.equal(flagged.eligible, true, 'most postings omit salary; rejecting them all would be useless');
    assert.equal(flagged.warnings[0]?.rule, 'salary');

    const strict = applyHardFilters(
      noSalary,
      criteria({ hard_filters: { ...threshold, on_unknown: { salary: 'reject' } } }),
    );
    assert.equal(strict.eligible, false, 'a user can demand a stated salary');

    const permissive = applyHardFilters(
      noSalary,
      criteria({ hard_filters: { ...threshold, on_unknown: { salary: 'allow' } } }),
    );
    assert.equal(permissive.warnings.length, 0);
  });

  it('refuses to compare across currencies rather than guessing a rate', () => {
    const verdict = applyHardFilters(
      { job: job({ salaryCurrency: 'EUR', salaryMin: 90_000, salaryMax: 110_000 }), postings: [posting()] },
      criteria({ hard_filters: { minimum_base_salary: { amount: 200_000, currency: 'USD' } } }),
    );

    assert.equal(verdict.eligible, true);
    assert.match(verdict.warnings[0]?.detail ?? '', /not comparable/);
  });

  it('rejects a denied application system only when every route is denied', () => {
    const config = criteria({ preferences: { application_system: { deny: ['workday'] } } });

    const onlyWorkday = applyHardFilters(
      { job: job(), postings: [posting({ applicationSystem: 'workday' })] },
      config,
    );
    assert.equal(onlyWorkday.eligible, false);

    const alsoGreenhouse = applyHardFilters(
      {
        job: job(),
        postings: [posting({ applicationSystem: 'workday' }), posting({ id: 'post_2', applicationSystem: 'greenhouse' })],
      },
      config,
    );
    assert.equal(alsoGreenhouse.eligible, true, 'one acceptable way to apply is enough');
  });

  it('rejects when the posting requires relocation', () => {
    const verdict = applyHardFilters(
      { job: job({ descriptionText: 'Relocation is required for this position.' }), postings: [posting()] },
      criteria({}),
    );

    assert.equal(verdict.eligible, false);
    assert.equal(verdict.rejections[0]?.rule, 'relocation');
  });

  it('applies no filters when none are configured', () => {
    const verdict = applyHardFilters({ job: job({ country: 'DE' }), postings: [posting()] }, criteria({}));
    assert.equal(verdict.eligible, true);
  });
});
