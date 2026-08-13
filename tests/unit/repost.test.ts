import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyReappearance } from '../../src/normalize/repost.js';

const base = {
  lastSeenAt: '2026-08-01T00:00:00.000Z',
  closedAt: undefined,
  previousSourceJobId: '1',
  currentSourceJobId: '1',
  previousDescriptionHash: 'hash-a',
  currentDescriptionHash: 'hash-a',
  seenAt: '2026-08-02T00:00:00.000Z',
  repostGapDays: 21,
};

describe('classifyReappearance', () => {
  it('reports an unchanged posting as seen again', () => {
    const result = classifyReappearance(base);
    assert.equal(result.eventType, 'seen_again');
    assert.equal(result.reason, undefined);
  });

  it('detects a content change', () => {
    const result = classifyReappearance({ ...base, currentDescriptionHash: 'hash-b' });
    assert.equal(result.eventType, 'changed');
  });

  it('treats reappearance after closure as a repost', () => {
    const result = classifyReappearance({ ...base, closedAt: '2026-07-20T00:00:00.000Z' });
    assert.equal(result.eventType, 'reposted');
    assert.match(result.reason ?? '', /closed/);
  });

  it('treats a changed source job id as a repost', () => {
    const result = classifyReappearance({ ...base, currentSourceJobId: '2' });
    assert.equal(result.eventType, 'reposted');
    assert.match(result.reason ?? '', /source job id/);
  });

  it('treats a long absence as a repost', () => {
    const result = classifyReappearance({ ...base, seenAt: '2026-09-05T00:00:00.000Z' });
    assert.equal(result.eventType, 'reposted');
    assert.match(result.reason ?? '', /days/);
  });

  it('respects a configured gap threshold', () => {
    const result = classifyReappearance({
      ...base,
      seenAt: '2026-08-09T00:00:00.000Z',
      repostGapDays: 7,
    });
    assert.equal(result.eventType, 'reposted');
  });
});
