import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { screenAuthenticity, type AuthenticityInput } from '../../src/evaluate/authenticity.js';
import { screeningSchema } from '../../src/config/screening-schema.js';
import type { JobRecord } from '../../src/db/repositories/jobs.js';
import type { SourcePosting } from '../../src/db/repositories/source-postings.js';
import type { JobSeenEvent } from '../../src/core/types.js';

const NOW = '2026-09-20T00:00:00.000Z';
const config = screeningSchema.parse({});

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job_1',
    companyId: 'co_1',
    companyName: 'Acme',
    title: 'Staff Engineer',
    normalizedTitle: 'staff engineer',
    level: 'staff',
    employmentType: 'full-time',
    workArrangement: 'remote',
    locationText: 'Remote',
    country: 'US',
    department: 'Engineering',
    team: undefined,
    salaryMin: undefined,
    salaryMax: undefined,
    salaryCurrency: undefined,
    salaryPeriod: undefined,
    descriptionText: 'x'.repeat(1200),
    descriptionHash: 'hash',
    contentKey: undefined,
    hasBody: true,
    fingerprint: 'fp',
    clusterKey: 'ck',
    inScope: true,
    scopeReason: undefined,
    postedAt: undefined,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: NOW,
    closedAt: undefined,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: NOW,
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
    locationText: 'Remote',
    captureMode: 'scoped',
    descriptionHash: 'hash',
    hasBody: true,
    postedAt: undefined,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: NOW,
    closedAt: undefined,
    ...over,
  };
}

function event(over: Partial<JobSeenEvent> = {}): JobSeenEvent {
  return {
    id: 'evt_1',
    jobId: 'job_1',
    seenAt: NOW,
    sourceType: 'greenhouse',
    sourceJobId: '1',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    eventType: 'seen_again',
    detail: undefined,
    ...over,
  };
}

function input(over: Partial<AuthenticityInput> = {}): AuthenticityInput {
  return {
    job: job(),
    postings: [posting()],
    events: [],
    duplicateCompanyCount: 1,
    now: NOW,
    ...over,
  };
}

describe('fraud signals', () => {
  it('detects a request for payment', () => {
    const verdict = screenAuthenticity(
      input({
        job: job({ descriptionText: 'You will need to purchase a starter kit for $250 before your first day.' }),
      }),
      config,
    );

    assert.equal(verdict.fraudRisk, 'high');
    assert.equal(verdict.blocked, true);
    assert.ok(verdict.signals.some((signal) => signal.code === 'payment-requested'));
  });

  it('detects an up-front fee', () => {
    const verdict = screenAuthenticity(
      input({ job: job({ descriptionText: 'A one-time registration fee applies to all applicants.' }) }),
      config,
    );

    assert.equal(verdict.fraudRisk, 'high');
    assert.ok(verdict.signals.some((signal) => signal.code === 'upfront-fee'));
  });

  it('does not flag ordinary job duties that mention money or equipment', () => {
    // Every one of these appears in real postings and must never be an alarm.
    const innocent = [
      'Assist with equipment procurement, set up lab space, and build wire harnesses and cable assemblies.',
      'You will own the payments platform and process transfers at scale.',
      'Manage a training budget and purchase tooling for the team.',
      'Deposit checks into the corporate account as part of the finance workflow.',
      'Build software that helps customers buy equipment online.',
    ];

    for (const text of innocent) {
      const verdict = screenAuthenticity(input({ job: job({ descriptionText: `${text} ${'x'.repeat(600)}` }) }), config);
      assert.equal(verdict.fraudRisk, 'low', `false positive on: ${text}`);
      assert.equal(verdict.blocked, false);
    }
  });

  it('detects check-deposit and crypto scams', () => {
    const check = screenAuthenticity(
      input({ job: job({ descriptionText: 'We will send a cashier check; deposit the check and wire the balance.' }) }),
      config,
    );
    assert.equal(check.fraudRisk, 'high');

    const crypto = screenAuthenticity(
      input({ job: job({ descriptionText: 'Salary is paid in bitcoin to your wallet weekly.' }) }),
      config,
    );
    assert.equal(crypto.fraudRisk, 'high');
  });

  it('detects redirection to a messaging app', () => {
    const verdict = screenAuthenticity(
      input({ job: job({ descriptionText: 'Contact our hiring manager on Telegram to apply for this role.' }) }),
      config,
    );

    assert.equal(verdict.fraudRisk, 'high');
    assert.ok(verdict.signals.some((signal) => signal.code === 'messaging-app-contact'));
  });

  it('does not flag a product that happens to be a messaging app', () => {
    const verdict = screenAuthenticity(
      input({
        job: job({ descriptionText: `Our team builds integrations with WhatsApp and Telegram for customers. ${'x'.repeat(600)}` }),
      }),
      config,
    );

    assert.equal(verdict.fraudRisk, 'low');
  });

  it('treats a free email contact as a concern rather than an alarm', () => {
    const verdict = screenAuthenticity(
      input({ job: job({ descriptionText: `Send your resume to acme.hiring@gmail.com. ${'x'.repeat(600)}` }) }),
      config,
    );

    assert.equal(verdict.fraudRisk, 'medium');
    assert.equal(verdict.blocked, false, 'a concern alone must not block the pipeline');
  });

  it('detects requests for identifiers no employer needs up front', () => {
    const verdict = screenAuthenticity(
      input({ job: job({ descriptionText: 'Please include your social security number and bank account number.' }) }),
      config,
    );

    assert.equal(verdict.fraudRisk, 'high');
  });

  it('does not flag a lawful background-check notice', () => {
    const verdict = screenAuthenticity(
      input({
        job: job({
          descriptionText: `This position requires a background check and government clearance eligibility. ${'x'.repeat(600)}`,
        }),
      }),
      config,
    );

    assert.equal(verdict.fraudRisk, 'low');
  });

  it('leaves an ordinary posting alone', () => {
    const verdict = screenAuthenticity(input(), config);

    assert.equal(verdict.fraudRisk, 'low');
    assert.equal(verdict.blocked, false);
    assert.equal(verdict.provenance, 'verified');
  });

  it('can be disabled entirely', () => {
    const verdict = screenAuthenticity(
      input({ job: job({ descriptionText: 'A one-time registration fee applies to all applicants.' }) }),
      screeningSchema.parse({ enabled: false }),
    );

    assert.equal(verdict.blocked, false);
    assert.equal(verdict.signals.length, 0);
  });

  it('can detect fraud but still not block when configured not to', () => {
    const verdict = screenAuthenticity(
      input({ job: job({ descriptionText: 'A one-time registration fee applies to all applicants.' }) }),
      screeningSchema.parse({ block_on_high_fraud_risk: false }),
    );

    assert.equal(verdict.fraudRisk, 'high');
    assert.equal(verdict.blocked, false);
  });
});

describe('longitudinal signals', () => {
  it('refuses to judge freshness before the observation window', () => {
    const verdict = screenAuthenticity(
      input({ job: job({ firstSeenAt: '2026-09-18T00:00:00.000Z' }) }),
      config,
    );

    assert.equal(verdict.freshness, 'unknown', 'one sighting is not evidence of anything');
    assert.equal(verdict.hiringIntent, 'unknown');
    assert.ok(verdict.signals.some((signal) => signal.code === 'insufficient-history'));
  });

  it('reports a long-open posting as stale once there is history', () => {
    const verdict = screenAuthenticity(
      input({ job: job({ firstSeenAt: '2026-06-01T00:00:00.000Z' }) }),
      config,
    );

    assert.equal(verdict.freshness, 'stale');
    assert.ok(verdict.signals.some((signal) => signal.code === 'long-open'));
  });

  it('reports frequent reposting as evergreen hiring intent', () => {
    const reposts = [1, 2, 3].map((index) =>
      event({ id: `evt_${index}`, eventType: 'reposted', detail: 'source job id changed' }),
    );

    const verdict = screenAuthenticity(
      input({ job: job({ firstSeenAt: '2026-06-01T00:00:00.000Z' }), events: reposts }),
      config,
    );

    assert.equal(verdict.hiringIntent, 'evergreen');
    assert.ok(verdict.signals.some((signal) => signal.code === 'frequent-reposts'));
    assert.ok(verdict.signals.some((signal) => signal.code === 'rotating-requisition-id'));
  });

  it('reports a normal mature posting as current and specific', () => {
    // 31 days observed: past the 21-day window, well inside the 60-day stale mark.
    const verdict = screenAuthenticity(
      input({ job: job({ firstSeenAt: '2026-08-20T00:00:00.000Z' }) }),
      config,
    );

    assert.equal(verdict.freshness, 'current');
    assert.equal(verdict.hiringIntent, 'specific');
  });
});

describe('provenance signals', () => {
  it('flags the same description appearing under many companies', () => {
    const verdict = screenAuthenticity(input({ duplicateCompanyCount: 4 }), config);

    assert.equal(verdict.provenance, 'suspicious');
    assert.ok(verdict.signals.some((signal) => signal.code === 'duplicated-across-companies'));
  });

  it('treats a single duplicate as a lesser concern', () => {
    const verdict = screenAuthenticity(input({ duplicateCompanyCount: 2 }), config);
    assert.equal(verdict.provenance, 'unverified');
  });

  it('flags a description too thin to be real', () => {
    const verdict = screenAuthenticity(input({ job: job({ descriptionText: 'Great job. Apply now.' }) }), config);

    assert.equal(verdict.provenance, 'unverified');
    assert.ok(verdict.signals.some((signal) => signal.code === 'thin-description'));
  });

  it('notes when no recognised ATS is involved', () => {
    const verdict = screenAuthenticity(
      input({ postings: [posting({ applicationSystem: undefined })] }),
      config,
    );

    assert.equal(verdict.provenance, 'unverified');
    assert.ok(verdict.signals.some((signal) => signal.code === 'unknown-application-system'));
  });

  it('says nothing about a body it does not have', () => {
    const verdict = screenAuthenticity(
      input({ job: job({ hasBody: false, descriptionText: '' }) }),
      config,
    );

    assert.equal(verdict.fraudRisk, 'low');
    assert.ok(!verdict.signals.some((signal) => signal.code === 'thin-description'));
  });
});
