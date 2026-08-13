import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parseGreenhouseBoard, boardUrl, GreenhouseAdapter } from '../../src/discovery/greenhouse.js';
import { normalizeDiscoveredJob } from '../../src/normalize/job.js';
import { silentLogger } from '../../src/util/logger.js';
import type { HttpClient } from '../../src/discovery/source-adapter.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function loadGreenhouseFixture(): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, 'greenhouse', 'board.json'), 'utf8'));
}

const config = {
  name: 'examplecorp',
  type: 'greenhouse' as const,
  enabled: true,
  company: 'Example Corp',
  board: 'examplecorp',
};

describe('greenhouse adapter', () => {
  it('builds the public board endpoint', () => {
    assert.equal(boardUrl('acme'), 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
  });

  it('maps the fixture payload to discovered jobs', () => {
    const jobs = parseGreenhouseBoard(loadGreenhouseFixture() as never, config);
    assert.equal(jobs.length, 3);

    const first = jobs[0];
    assert.ok(first);
    assert.equal(first.sourceType, 'greenhouse');
    assert.equal(first.sourceJobId, '4012345');
    assert.equal(first.companyName, 'Example Corp');
    assert.equal(first.title, 'Principal Software Engineer, Loyalty Platform');
    assert.equal(first.location, 'Seattle, WA (Hybrid)');
    // The adapter passes the body through still escaped; htmlToText owns decoding,
    // so a double-escaped payload cannot skip a sanitizing pass.
    assert.match(first.descriptionHtml ?? '', /&lt;strong&gt;Principal Software Engineer&lt;\/strong&gt;/);
  });

  it('skips entries without a title or url', () => {
    const jobs = parseGreenhouseBoard({ jobs: [{ id: 1 }, { title: 'No URL' }] } as never, config);
    assert.equal(jobs.length, 0);
  });

  it('normalizes a fixture posting end to end', () => {
    const jobs = parseGreenhouseBoard(loadGreenhouseFixture() as never, config);
    const first = jobs[0];
    assert.ok(first);

    const normalized = normalizeDiscoveredJob(first);
    // "Corp" is a legal suffix and is stripped from the canonical company key.
    assert.equal(normalized.normalizedCompanyName, 'example');
    assert.equal(normalized.level, 'principal');
    assert.equal(normalized.workArrangement, 'hybrid');
    assert.equal(normalized.country, 'US');
    assert.equal(normalized.salaryMin, 220_000);
    assert.equal(normalized.salaryMax, 265_000);
    assert.equal(normalized.salaryPeriod, 'year');
    assert.equal(normalized.applicationSystem, 'greenhouse');
    assert.equal(normalized.identityKey, 'src:greenhouse:4012345');
    assert.equal(normalized.identityTier, 'source-id');
    // Tracking parameters must not survive into the canonical URL.
    assert.equal(normalized.canonicalUrl, 'https://boards.greenhouse.io/examplecorp/jobs/4012345');
    assert.ok(!normalized.descriptionText.includes('<'));
    assert.match(normalized.descriptionText, /• Design event-driven services/);
  });

  it('fails with a source error when the payload is unexpected', async () => {
    const http: HttpClient = {
      getText: async () => '',
      getJson: async () => ({ error: 'nope' }) as never,
    };
    const adapter = new GreenhouseAdapter();

    await assert.rejects(() => adapter.scan(config, { http, logger: silentLogger }), /unexpected payload/);
  });

  it('fetches through the injected http client', async () => {
    const requested: string[] = [];
    const http: HttpClient = {
      getText: async () => '',
      getJson: async (url: string) => {
        requested.push(url);
        return loadGreenhouseFixture() as never;
      },
    };

    const jobs = await new GreenhouseAdapter().scan(config, { http, logger: silentLogger });
    assert.deepEqual(requested, [boardUrl('examplecorp')]);
    assert.equal(jobs.length, 3);
  });
});
