import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CareerPageAdapter,
  collectJobPostings,
  extractJsonLdBlocks,
  findAtsHints,
  parseCareerPage,
} from '../../src/discovery/career-page.js';
import { renderWithBrowser } from '../../src/discovery/browser.js';
import {
  captureFromUrl,
  parseAshbyUrl,
  parseGreenhouseUrl,
  parseLeverUrl,
} from '../../src/discovery/capture.js';
import { normalizeDiscoveredJob } from '../../src/normalize/job.js';
import { silentLogger } from '../../src/util/logger.js';
import type { HttpClient } from '../../src/discovery/source-adapter.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const html = readFileSync(path.join(fixturesDir, 'career-page', 'jobs.html'), 'utf8');

const config = {
  name: 'example-systems',
  type: 'career-page' as const,
  enabled: true,
  company: 'Example Systems',
  url: 'https://careers.example-systems.test/',
  browser_fallback: false,
};

describe('career page adapter', () => {
  it('extracts valid JSON-LD blocks and skips broken ones', () => {
    const blocks = extractJsonLdBlocks(html);
    assert.equal(blocks.length, 2, 'the malformed third block must not lose the valid two');
  });

  it('finds postings inside a @graph container', () => {
    const blocks = extractJsonLdBlocks(html);
    const postings = blocks.flatMap((block) => collectJobPostings(block));
    assert.equal(postings.length, 2);
  });

  it('maps a posting with structured salary and location', () => {
    const { jobs } = parseCareerPage(html, config, config.url);
    const principal = jobs.find((job) => job.title.startsWith('Principal'));
    assert.ok(principal);

    assert.equal(principal.companyName, 'Example Systems');
    assert.equal(principal.sourceJobId, 'ES-2041');
    assert.equal(principal.location, 'Seattle, WA, US');
    assert.equal(principal.employmentType, 'full-time');
    assert.equal(principal.salary?.min, 210_000);
    assert.equal(principal.salary?.max, 260_000);
    assert.equal(principal.salary?.period, 'year');
    assert.equal(principal.url, 'https://careers.example-systems.test/roles/principal-platform-engineer');
  });

  it('treats TELECOMMUTE as remote', () => {
    const { jobs } = parseCareerPage(html, config, config.url);
    const remote = jobs.find((job) => job.title.startsWith('Staff'));
    assert.ok(remote);
    assert.equal(remote.workArrangement, 'remote');

    const normalized = normalizeDiscoveredJob(remote);
    assert.equal(normalized.workArrangement, 'remote');
  });

  it('sanitizes escaped markup in the description', () => {
    const { jobs } = parseCareerPage(html, config, config.url);
    const principal = jobs.find((job) => job.title.startsWith('Principal'));
    assert.ok(principal);

    const normalized = normalizeDiscoveredJob(principal);
    assert.match(normalized.descriptionText, /Own the platform/);
    assert.match(normalized.descriptionText, /• Design distributed services/);
    assert.ok(!/<[a-z!/][^>]*>/i.test(normalized.descriptionText));
  });

  it('detects linked ATS boards so the user can configure them directly', () => {
    assert.deepEqual(findAtsHints(html), ['greenhouse']);
  });

  it('fails with an actionable message when a page has no structured data', async () => {
    const http: HttpClient = { getText: async () => '<html><body>No data</body></html>', getJson: async () => ({}) as never };

    await assert.rejects(
      () => new CareerPageAdapter().scan(config, { http, logger: silentLogger }),
      /no schema.org JobPosting data found.*browser_fallback/s,
    );
  });

  it('mentions a linked ATS board when the static page has no postings', async () => {
    const http: HttpClient = {
      getText: async () => '<a href="https://jobs.lever.co/acme">roles</a>',
      getJson: async () => ({}) as never,
    };

    await assert.rejects(
      () => new CareerPageAdapter().scan(config, { http, logger: silentLogger }),
      /links to lever/,
    );
  });

  it('scans successfully through the adapter', async () => {
    const http: HttpClient = { getText: async () => html, getJson: async () => ({}) as never };
    const jobs = await new CareerPageAdapter().scan(config, { http, logger: silentLogger });
    assert.equal(jobs.length, 2);
  });
});

describe('browser fallback', () => {
  it('explains how to enable playwright when it cannot be loaded', async () => {
    await assert.rejects(
      () =>
        renderWithBrowser('https://example.com/careers', silentLogger, {
          load: async () => {
            throw new Error('Cannot find module');
          },
        }),
      /npm install playwright/,
    );
  });

  it('renders and closes the browser when playwright is available', async () => {
    let closed = false;
    const rendered = await renderWithBrowser('https://example.com/careers', silentLogger, {
      load: async () => ({
        chromium: {
          launch: async () => ({
            newPage: async () => ({
              goto: async () => undefined,
              content: async () => '<html>rendered</html>',
            }),
            close: async () => {
              closed = true;
            },
          }),
        },
      }),
    });

    assert.equal(rendered, '<html>rendered</html>');
    assert.equal(closed, true, 'the browser must always be closed');
  });

  it('applies the url guard before launching a browser', async () => {
    let launched = false;
    await assert.rejects(() =>
      renderWithBrowser('https://127.0.0.1/careers', silentLogger, {
        load: async () => {
          launched = true;
          throw new Error('should not reach here');
        },
      }),
    );
    assert.equal(launched, false, 'a blocked URL must not start a browser');
  });
});

describe('single-url capture', () => {
  it('recognizes greenhouse posting urls', () => {
    assert.deepEqual(parseGreenhouseUrl(new URL('https://boards.greenhouse.io/acme/jobs/4012345')), {
      board: 'acme',
      jobId: '4012345',
    });
    assert.deepEqual(parseGreenhouseUrl(new URL('https://job-boards.greenhouse.io/acme/jobs/99?gh_src=x')), {
      board: 'acme',
      jobId: '99',
    });
    assert.equal(parseGreenhouseUrl(new URL('https://example.com/jobs/1')), undefined);
  });

  it('recognizes lever and ashby posting urls', () => {
    assert.deepEqual(parseLeverUrl(new URL('https://jobs.lever.co/shieldai/41468aca-c1c2-4a7b-aec8-f499e64b6d1e')), {
      site: 'shieldai',
      jobId: '41468aca-c1c2-4a7b-aec8-f499e64b6d1e',
    });
    assert.deepEqual(parseAshbyUrl(new URL('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-9f2c-000000000000')), {
      board: 'ramp',
      jobId: '34413f8d-26bf-4bbc-9f2c-000000000000',
    });
  });

  it('uses the greenhouse single-posting endpoint', async () => {
    const requested: string[] = [];
    const http: HttpClient = {
      getText: async () => '',
      getJson: async (url: string) => {
        requested.push(url);
        return {
          id: 4012345,
          title: 'Staff Engineer',
          absolute_url: 'https://boards.greenhouse.io/acme/jobs/4012345',
          location: { name: 'Remote - US' },
          content: '&lt;p&gt;Build things&lt;/p&gt;',
        } as never;
      },
    };

    const jobs = await captureFromUrl('https://boards.greenhouse.io/acme/jobs/4012345?utm_source=x', {
      http,
      logger: silentLogger,
      company: 'Acme',
    });

    assert.deepEqual(requested, ['https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345']);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.companyName, 'Acme');
    assert.equal(jobs[0]?.sourceType, 'greenhouse');
  });

  it('falls back to page JSON-LD for an unknown host', async () => {
    const http: HttpClient = { getText: async () => html, getJson: async () => ({}) as never };

    const jobs = await captureFromUrl('https://careers.example-systems.test/roles/principal', {
      http,
      logger: silentLogger,
    });

    assert.equal(jobs.length, 2);
    assert.equal(jobs[0]?.sourceType, 'career-page');
  });

  it('rejects a non-http url before any request', async () => {
    let called = false;
    const http: HttpClient = {
      getText: async () => {
        called = true;
        return '';
      },
      getJson: async () => {
        called = true;
        return {} as never;
      },
    };

    await assert.rejects(() => captureFromUrl('file:///c:/secrets.txt', { http, logger: silentLogger }));
    assert.equal(called, false);
  });

  it('reports clearly when a page has no structured data', async () => {
    const http: HttpClient = { getText: async () => '<html></html>', getJson: async () => ({}) as never };
    await assert.rejects(
      () => captureFromUrl('https://example.com/some-job', { http, logger: silentLogger }),
      /no structured job data/,
    );
  });
});
