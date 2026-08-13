import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { htmlToText, normalizeWhitespace, stripControlCharacters, capDescription } from '../../src/normalize/text.js';
import { normalizeDiscoveredJob } from '../../src/normalize/job.js';
import { parseGreenhouseBoard } from '../../src/discovery/greenhouse.js';
import { redactString, redactUrl, REDACTED } from '../../src/util/logger.js';
import { assertUrlAllowed, isPrivateAddress, BlockedRequestError } from '../../src/discovery/url-guard.js';
import { createHttpClient } from '../../src/discovery/http.js';
import { silentLogger } from '../../src/util/logger.js';
import type { DiscoveredJob } from '../../src/core/types.js';

/**
 * Job postings are third-party content fetched over the network. These tests
 * pin the boundary behaviour that keeps hostile postings inert.
 */

describe('terminal escape injection', () => {
  it('drops escape sequences smuggled in as numeric entities', () => {
    const malicious = 'Great role &#27;[2J&#27;[1;1H FAKE APPLY URL &#x1b;]8;;http://evil.example&#x1b;\\';
    const text = htmlToText(malicious);

    assert.ok(!text.includes('\u001b'), 'ESC must not survive entity decoding');
    assert.ok(!/[\u0000-\u0008\u000e-\u001f]/.test(text));
  });

  it('drops raw control characters arriving in plain fields', () => {
    assert.equal(stripControlCharacters('a\u001b[31mb\u0007c'), 'a[31mbc');
    assert.equal(normalizeWhitespace('title\u001b[2Jhere'), 'title[2Jhere');
  });

  it('sanitizes titles and locations from an adapter payload', () => {
    const jobs = parseGreenhouseBoard(
      {
        jobs: [
          {
            id: 1,
            title: 'Staff\u001b[2J Engineer',
            absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
            location: { name: 'Seattle\u0007, WA' },
            content: 'hi',
          },
        ],
      } as never,
      { name: 'acme', type: 'greenhouse', enabled: true, company: 'Acme', board: 'acme' },
    );

    const job = jobs[0];
    assert.ok(job);
    assert.equal(job.title, 'Staff[2J Engineer');
    assert.equal(job.location, 'Seattle, WA');
  });
});

describe('escaped markup cannot be re-materialized', () => {
  it('does not turn escaped markup back into live html', () => {
    const text = htmlToText('&lt;img src=x onerror=alert(1)&gt;');
    assert.ok(!text.includes('<img'), 'entity-encoded markup must not become markup');
    assert.ok(!text.includes('onerror='), 'event handler must not survive');
  });

  it('defeats double-escaped payloads', () => {
    const text = htmlToText('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;');
    assert.ok(!text.includes('<script'));
  });

  it('handles greenhouse escaped content end to end without leaking markup', () => {
    const jobs = parseGreenhouseBoard(
      {
        jobs: [
          {
            id: 7,
            title: 'Engineer',
            absolute_url: 'https://boards.greenhouse.io/acme/jobs/7',
            location: { name: 'Remote' },
            content: '&lt;p&gt;Real text&lt;/p&gt;&lt;img src=x onerror=steal()&gt;',
          },
        ],
      } as never,
      { name: 'acme', type: 'greenhouse', enabled: true, company: 'Acme', board: 'acme' },
    );

    const job = jobs[0];
    assert.ok(job);
    const normalized = normalizeDiscoveredJob(job);
    assert.match(normalized.descriptionText, /Real text/);
    assert.ok(!normalized.descriptionText.includes('<'));
    assert.ok(!normalized.descriptionText.includes('onerror'));
  });

  it('still strips real markup and keeps readable structure', () => {
    const text = htmlToText('<p>Intro</p><ul><li>One</li></ul><script>evil()</script>');
    assert.match(text, /Intro/);
    assert.match(text, /• One/);
    assert.ok(!text.includes('evil()'));
  });
});

describe('description size limits', () => {
  it('caps an oversized description', () => {
    const capped = capDescription('x'.repeat(50), 20);
    assert.ok(capped.startsWith('x'.repeat(20)));
    assert.ok(!capped.includes('x'.repeat(21)));
    assert.match(capped, /truncated by roleeye at 20 characters/);
  });

  it('caps descriptions during normalization', () => {
    const job: DiscoveredJob = {
      sourceType: 'greenhouse',
      sourceName: 'acme',
      sourceJobId: '1',
      companyName: 'Acme',
      title: 'Engineer',
      url: 'https://boards.greenhouse.io/acme/jobs/1',
      description: 'a'.repeat(200_000),
    };

    const normalized = normalizeDiscoveredJob(job);
    assert.ok(normalized.descriptionText.length <= 100_200);
  });
});

describe('secret redaction', () => {
  it('redacts credentials embedded in a url', () => {
    assert.equal(redactString('https://user:hunter2@example.com/x'), `https://${REDACTED}@example.com/x`);
  });

  it('redacts secrets carried in query strings', () => {
    assert.match(redactString('GET https://a.example/x?api_key=abcdef123456&b=1'), /api_key=\[redacted\]/);
    assert.match(redactString('?access_token=zzz'), /access_token=\[redacted\]/);
  });

  it('redactUrl strips userinfo and sensitive params but keeps the host visible', () => {
    const result = redactUrl('https://user:pw@boards.example.com/jobs?token=secret&page=2');
    assert.match(result, /boards\.example\.com/);
    assert.ok(!result.includes('pw'));
    assert.ok(!result.includes('secret'));
    assert.match(result, /page=2/);
  });

  it('leaves ordinary urls untouched', () => {
    const url = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';
    assert.equal(redactUrl(url), url);
  });
});

describe('url guard', () => {
  const resolve = async (hostname: string): Promise<string[]> => {
    if (hostname === 'public.example') return ['93.184.216.34'];
    if (hostname === 'sneaky.example') return ['169.254.169.254'];
    if (hostname === 'internal.example') return ['10.0.0.5'];
    return [];
  };

  it('classifies private and public addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1']) {
      assert.equal(isPrivateAddress(address), true, `${address} must be private`);
    }
    assert.equal(isPrivateAddress('93.184.216.34'), false);
    assert.equal(isPrivateAddress('8.8.8.8'), false);
  });

  it('allows a normal public https url', async () => {
    const url = await assertUrlAllowed('https://public.example/jobs', { resolve });
    assert.equal(url.hostname, 'public.example');
  });

  it('blocks cloud metadata by hostname resolution', async () => {
    await assert.rejects(() => assertUrlAllowed('https://sneaky.example/', { resolve }), BlockedRequestError);
  });

  it('blocks private targets, loopback names, and literal addresses', async () => {
    await assert.rejects(() => assertUrlAllowed('https://internal.example/', { resolve }), BlockedRequestError);
    await assert.rejects(() => assertUrlAllowed('https://localhost/x', { resolve }), BlockedRequestError);
    await assert.rejects(() => assertUrlAllowed('https://127.0.0.1:9200/_search', { resolve }), BlockedRequestError);
    await assert.rejects(() => assertUrlAllowed('https://[::1]/x', { resolve }), BlockedRequestError);
  });

  it('blocks non-https and non-http schemes', async () => {
    await assert.rejects(() => assertUrlAllowed('http://public.example/', { resolve }), BlockedRequestError);
    await assert.rejects(() => assertUrlAllowed('file:///c:/secrets.txt', { resolve }), BlockedRequestError);
  });
});

describe('http client hardening', () => {
  const resolve = async (hostname: string): Promise<string[]> =>
    hostname === 'public.example' ? ['93.184.216.34'] : ['10.0.0.1'];

  function client(fetchImpl: typeof fetch, maxBytes?: number) {
    return createHttpClient({
      userAgent: 'roleeye-test',
      timeoutMs: 1000,
      delayMs: 0,
      maxRetries: 1,
      logger: silentLogger,
      fetchImpl,
      resolveHost: resolve,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
  }

  it('refuses to follow a redirect to a private address', async () => {
    const http = client(async () =>
      new Response(null, { status: 302, headers: { location: 'https://internal.example/admin' } }),
    );

    await assert.rejects(() => http.getJson('https://public.example/board'), /private address|blocked/i);
  });

  it('follows a permitted public redirect', async () => {
    let hops = 0;
    const http = client(async (url) => {
      hops += 1;
      if (String(url).endsWith('/board')) {
        return new Response(null, { status: 302, headers: { location: 'https://public.example/final' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const result = await http.getJson<{ ok: boolean }>('https://public.example/board');
    assert.equal(result.ok, true);
    assert.equal(hops, 2);
  });

  it('stops a redirect loop', async () => {
    const http = client(async () =>
      new Response(null, { status: 302, headers: { location: 'https://public.example/loop' } }),
    );
    await assert.rejects(() => http.getJson('https://public.example/loop'), /too many redirects/);
  });

  it('rejects a response larger than the cap', async () => {
    const http = client(async () => new Response('x'.repeat(5000), { status: 200 }), 1000);
    await assert.rejects(() => http.getJson('https://public.example/big'), /exceeds 1000 bytes/);
  });

  it('rejects an oversized declared content-length without reading the body', async () => {
    const http = client(
      async () => new Response('small', { status: 200, headers: { 'content-length': '999999999' } }),
      1000,
    );
    await assert.rejects(() => http.getJson('https://public.example/lying'), /exceeds 1000 bytes/);
  });

  it('does not retry a blocked url', async () => {
    let calls = 0;
    const http = client(async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    });

    await assert.rejects(() => http.getJson('https://internal.example/x'));
    assert.equal(calls, 0, 'blocked before any request is made');
  });
});
