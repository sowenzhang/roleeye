import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Fact } from '../../src/db/repositories/facts.js';
import { validateClaim, validateClaims } from '../../src/resume/validate.js';

/**
 * These tests are written adversarially: each one is a way a model actually
 * embellishes when asked to "tailor" a resume. The promise is that none of them
 * can reach a document, so each must be caught here rather than reasoned about.
 */

function fact(over: Partial<Fact> = {}): Fact {
  return {
    id: 'fact_1',
    experienceId: 'exp_1',
    statement: 'Reduced p99 checkout latency by 43% by rewriting the pricing service in Go.',
    statementHash: 'hash',
    tags: [],
    status: 'approved',
    approvedAt: '2026-08-14T00:00:00.000Z',
    importId: undefined,
    origin: 'import',
    retiredAt: undefined,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...over,
  };
}

const facts = new Map([['fact_1', fact()]]);

describe('claim validation', () => {
  it('accepts a reworded claim that stays inside its facts', () => {
    const result = validateClaim(
      { text: 'Cut p99 checkout latency 43% with a Go rewrite of the pricing service.', factIds: ['fact_1'] },
      facts,
    );

    assert.equal(result.supported, true, JSON.stringify(result.problems));
  });

  it('rejects a number that is not in the cited facts', () => {
    const result = validateClaim(
      { text: 'Cut p99 checkout latency by 60% in the pricing service.', factIds: ['fact_1'] },
      facts,
    );

    assert.equal(result.supported, false);
    assert.equal(result.problems[0]?.code, 'invented-number');
  });

  it('rejects a technology the candidate never claimed', () => {
    const result = validateClaim(
      { text: 'Cut p99 checkout latency by 43% using Kubernetes and Go.', factIds: ['fact_1'] },
      facts,
    );

    assert.equal(result.supported, false);
    assert.ok(result.problems.some((problem) => problem.code === 'invented-term'));
  });

  it('rejects an uncited claim even when it is true', () => {
    const result = validateClaim({ text: 'Rewrote the pricing service in Go.', factIds: [] }, facts);

    assert.equal(result.supported, false);
    assert.equal(result.problems[0]?.code, 'no-citation');
  });

  it('rejects a claim citing a fact that is still a draft', () => {
    const draft = new Map([['fact_2', fact({ id: 'fact_2', status: 'draft', approvedAt: undefined })]]);
    const result = validateClaim({ text: 'Rewrote the pricing service in Go.', factIds: ['fact_2'] }, draft);

    assert.equal(result.supported, false);
    assert.equal(result.problems[0]?.code, 'unapproved-fact');
  });

  it('rejects a claim citing a retired fact', () => {
    const retired = new Map([['fact_1', fact({ retiredAt: '2026-08-14T01:00:00.000Z' })]]);
    const result = validateClaim({ text: 'Rewrote the pricing service in Go.', factIds: ['fact_1'] }, retired);

    assert.equal(result.supported, false);
    assert.equal(result.problems[0]?.code, 'unapproved-fact');
  });

  it('rejects a citation to a fact that does not exist', () => {
    const result = validateClaim({ text: 'Rewrote the pricing service in Go.', factIds: ['fact_9'] }, facts);

    assert.equal(result.supported, false);
    assert.equal(result.problems[0]?.code, 'unknown-fact');
  });

  it('does not treat the first word of a bullet as a claim', () => {
    // Every bullet starts with a capitalised verb; flagging those would make
    // validation useless by making everything fail.
    const result = validateClaim(
      { text: 'Rewrote the pricing service in Go, cutting p99 latency 43%.', factIds: ['fact_1'] },
      facts,
    );

    assert.equal(result.supported, true, JSON.stringify(result.problems));
  });

  it('reads magnitude words as numbers', () => {
    const scale = new Map([
      ['fact_1', fact({ statement: 'Ran a platform serving 2 million daily transactions.' })],
    ]);

    const honest = validateClaim({ text: 'Served 2 million daily transactions.', factIds: ['fact_1'] }, scale);
    const inflated = validateClaim({ text: 'Served 20 million daily transactions.', factIds: ['fact_1'] }, scale);

    assert.equal(honest.supported, true, JSON.stringify(honest.problems));
    assert.equal(inflated.supported, false);
  });

  it('accepts the employer and dates of the experience a cited fact belongs to', () => {
    // Found by a live run: a model wrote "Staff software engineer at Acme Corp
    // since 2019", which the store knows from the imported experience block but
    // no fact statement repeats. Rejecting it made the summary unwriteable.
    const experiences = new Map([
      ['exp_1', { company: 'Acme Corp', role: 'Staff Software Engineer', startedOn: 'Jan 2019', endedOn: 'Present' }],
    ]);

    const result = validateClaim(
      { text: 'Staff Software Engineer at Acme Corp since 2019, cutting p99 latency 43%.', factIds: ['fact_1'] },
      facts,
      { experiences },
    );

    assert.equal(result.supported, true, JSON.stringify(result.problems));
  });

  it('does not let a claim borrow an employer it never cited', () => {
    const experiences = new Map([
      ['exp_2', { company: 'Globex', role: 'Senior Engineer', startedOn: '2015', endedOn: '2019' }],
    ]);

    const result = validateClaim(
      { text: 'Cut p99 latency 43% at Globex.', factIds: ['fact_1'] },
      facts,
      { experiences },
    );

    assert.equal(result.supported, false);
    assert.ok(result.problems.some((problem) => problem.detail.includes('GLOBEX')));
  });

  it('validates a list in one pass', () => {
    const results = validateClaims(
      [
        { text: 'Cut p99 checkout latency 43% in the pricing service.', factIds: ['fact_1'] },
        { text: 'Cut costs by 90% across the company.', factIds: ['fact_1'] },
      ],
      [fact()],
    );

    assert.deepEqual(
      results.map((result) => result.supported),
      [true, false],
    );
  });
});
