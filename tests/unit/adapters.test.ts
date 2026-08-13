import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parseLeverPostings, postingsUrl, LeverAdapter } from '../../src/discovery/lever.js';
import { parseAshbyBoard, jobBoardUrl, AshbyAdapter } from '../../src/discovery/ashby.js';
import { normalizeDiscoveredJob } from '../../src/normalize/job.js';
import { silentLogger } from '../../src/util/logger.js';
import type { HttpClient } from '../../src/discovery/source-adapter.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixture(...parts: string[]): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, ...parts), 'utf8'));
}

const leverConfig = {
  name: 'shieldai',
  type: 'lever' as const,
  enabled: true,
  company: 'Shield AI',
  site: 'shieldai',
};

const ashbyConfig = {
  name: 'ramp',
  type: 'ashby' as const,
  enabled: true,
  company: 'Ramp',
  board: 'Ramp',
};

describe('lever adapter', () => {
  it('builds the public postings endpoint', () => {
    assert.equal(postingsUrl('acme co'), 'https://api.lever.co/v0/postings/acme%20co?mode=json');
  });

  it('maps the fixture payload', () => {
    const jobs = parseLeverPostings(fixture('lever', 'postings.json'), leverConfig);
    assert.equal(jobs.length, 3);

    const first = jobs[0];
    assert.ok(first);
    assert.equal(first.sourceType, 'lever');
    assert.equal(first.companyName, 'Shield AI');
    assert.ok(first.sourceJobId && first.sourceJobId.length > 10);
    assert.ok(first.url.startsWith('https://jobs.lever.co/'));
    assert.ok(first.department);
  });

  it('uses the structured salary range rather than parsing prose', () => {
    const jobs = parseLeverPostings(fixture('lever', 'postings.json'), leverConfig);
    const withSalary = jobs.find((job) => job.salary?.min !== undefined);
    assert.ok(withSalary, 'fixture should contain a posting with a salary range');
    assert.equal(withSalary.salary?.period, 'year');
    assert.ok((withSalary.salary?.min ?? 0) > 0);
    assert.ok((withSalary.salary?.max ?? 0) >= (withSalary.salary?.min ?? 0));
  });

  it('trusts the stated workplace type over inference', () => {
    const jobs = parseLeverPostings(fixture('lever', 'postings.json'), leverConfig);
    const remote = jobs.find((job) => job.workArrangement === 'remote');
    assert.ok(remote, 'fixture should contain a remote posting');

    const normalized = normalizeDiscoveredJob(remote);
    assert.equal(normalized.workArrangement, 'remote');
  });

  it('combines description, lists, and additional sections into one body', () => {
    const jobs = parseLeverPostings(fixture('lever', 'postings.json'), leverConfig);
    const first = jobs[0];
    assert.ok(first);

    const normalized = normalizeDiscoveredJob(first);
    assert.ok(normalized.descriptionText.length > 200);
    assert.ok(!normalized.descriptionText.includes('<'));
  });

  it('skips postings without a title or url', () => {
    const jobs = parseLeverPostings([{ id: 'x' }, { text: 'No URL' }], leverConfig);
    assert.equal(jobs.length, 0);
  });

  it('rejects a payload that is not an array', () => {
    assert.throws(() => parseLeverPostings({ postings: [] }, leverConfig), /unexpected payload/);
  });

  it('fetches through the injected http client', async () => {
    const requested: string[] = [];
    const http: HttpClient = {
      getText: async () => '',
      getJson: async (url: string) => {
        requested.push(url);
        return fixture('lever', 'postings.json') as never;
      },
    };

    const jobs = await new LeverAdapter().scan(leverConfig, { http, logger: silentLogger });
    assert.deepEqual(requested, [postingsUrl('shieldai')]);
    assert.equal(jobs.length, 3);
  });
});

describe('ashby adapter', () => {
  it('builds the public job board endpoint', () => {
    assert.equal(
      jobBoardUrl('Acme'),
      'https://api.ashbyhq.com/posting-api/job-board/Acme?includeCompensation=true',
    );
  });

  it('maps the fixture payload', () => {
    const jobs = parseAshbyBoard(fixture('ashby', 'job-board.json') as never, ashbyConfig);
    assert.equal(jobs.length, 3);

    const first = jobs[0];
    assert.ok(first);
    assert.equal(first.sourceType, 'ashby');
    assert.equal(first.companyName, 'Ramp');
    assert.ok(first.title.length > 0);
    assert.ok(first.department);
  });

  it('extracts salary components and ignores equity', () => {
    const jobs = parseAshbyBoard(fixture('ashby', 'job-board.json') as never, ashbyConfig);
    const withSalary = jobs.find((job) => job.salary?.min !== undefined);
    assert.ok(withSalary, 'fixture should contain compensation data');
    assert.equal(withSalary.salary?.period, 'year');
    assert.ok((withSalary.salary?.min ?? 0) > 1000, 'equity percentages must not be read as salary');
  });

  it('skips unlisted postings', () => {
    const jobs = parseAshbyBoard(
      {
        jobs: [
          { id: '1', title: 'Listed', jobUrl: 'https://jobs.ashbyhq.com/acme/1', isListed: true },
          { id: '2', title: 'Draft', jobUrl: 'https://jobs.ashbyhq.com/acme/2', isListed: false },
        ],
      } as never,
      ashbyConfig,
    );

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.title, 'Listed');
  });

  it('joins secondary locations', () => {
    const jobs = parseAshbyBoard(
      {
        jobs: [
          {
            id: '1',
            title: 'Engineer',
            jobUrl: 'https://jobs.ashbyhq.com/acme/1',
            location: 'New York',
            secondaryLocations: [{ location: 'Austin' }, { location: 'Remote (US)' }],
          },
        ],
      } as never,
      ashbyConfig,
    );

    assert.equal(jobs[0]?.location, 'New York / Austin / Remote (US)');
  });

  it('rejects an unexpected payload', async () => {
    const http: HttpClient = { getText: async () => '', getJson: async () => ({ data: [] }) as never };
    await assert.rejects(
      () => new AshbyAdapter().scan(ashbyConfig, { http, logger: silentLogger }),
      /unexpected payload/,
    );
  });
});

describe('cross-source normalization', () => {
  it('produces stable identities for every adapter', () => {
    const lever = parseLeverPostings(fixture('lever', 'postings.json'), leverConfig).map(normalizeDiscoveredJob);
    const ashby = parseAshbyBoard(fixture('ashby', 'job-board.json') as never, ashbyConfig).map(normalizeDiscoveredJob);

    for (const job of [...lever, ...ashby]) {
      assert.equal(job.identityTier, 'source-id');
      assert.ok(job.identityKey.startsWith('src:'));
      assert.ok(job.fingerprint.length === 64);
      // Prose legitimately contains a stray "<"; what must not survive is a tag.
      assert.ok(!/<[a-z!/][^>]*>/i.test(job.descriptionText), `markup survived in ${job.title}`);
    }
  });
});
