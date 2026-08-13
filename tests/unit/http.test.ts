import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHttpClient } from '../../src/discovery/http.js';
import { silentLogger } from '../../src/util/logger.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch, maxRetries = 2) {
  return createHttpClient({
    userAgent: 'roleeye-test',
    timeoutMs: 1000,
    delayMs: 0,
    maxRetries,
    logger: silentLogger,
    fetchImpl,
  });
}

describe('http client', () => {
  it('sends the configured user agent', async () => {
    let seenAgent: string | undefined;
    const http = client(async (_url, init) => {
      seenAgent = new Headers(init?.headers).get('user-agent') ?? undefined;
      return jsonResponse({ ok: true });
    });

    await http.getJson('https://example.com/a');
    assert.equal(seenAgent, 'roleeye-test');
  });

  it('retries retryable status codes', async () => {
    let calls = 0;
    const http = client(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse({}, 503);
      return jsonResponse({ ok: true });
    });

    const result = await http.getJson<{ ok: boolean }>('https://example.com/b');
    assert.equal(result.ok, true);
    assert.equal(calls, 3);
  });

  it('does not retry non-retryable status codes', async () => {
    let calls = 0;
    const http = client(async () => {
      calls += 1;
      return jsonResponse({}, 404);
    });

    await assert.rejects(() => http.getJson('https://example.com/c'), /404/);
    assert.equal(calls, 1, 'a 404 must not be retried');
  });

  it('gives up after the retry budget', async () => {
    let calls = 0;
    const http = client(async () => {
      calls += 1;
      return jsonResponse({}, 503);
    });

    await assert.rejects(() => http.getJson('https://example.com/d'), /503/);
    assert.equal(calls, 3);
  });

  it('reports non-JSON payloads clearly', async () => {
    const http = client(async () => new Response('<html>maintenance</html>', { status: 200 }));
    await assert.rejects(() => http.getJson('https://example.com/e'), /expected JSON/);
  });
});
