import { SourceError } from '../util/errors.js';
import { sleep } from '../util/time.js';
import type { Logger } from '../util/logger.js';
import type { HttpClient } from './source-adapter.js';

export interface HttpClientOptions {
  userAgent: string;
  timeoutMs: number;
  /** Minimum delay between requests. Politeness is a hard requirement. */
  delayMs: number;
  maxRetries?: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, url: string) {
    super(`HTTP ${status} ${statusText} for ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/**
 * Rate-limited fetch wrapper with bounded retries.
 *
 * We deliberately respect Retry-After and never attempt to evade rate limits or
 * authentication (agent.md discovery rules).
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const { userAgent, timeoutMs, delayMs, maxRetries = 2, logger } = options;
  const doFetch = options.fetchImpl ?? fetch;
  let nextAllowedAt = 0;

  async function throttle(): Promise<void> {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextAllowedAt = Date.now() + delayMs;
  }

  async function request(url: string, init?: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await throttle();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await doFetch(url, {
          ...init,
          signal: controller.signal,
          headers: {
            accept: 'application/json, text/html;q=0.9, */*;q=0.8',
            'user-agent': userAgent,
            ...(init?.headers ?? {}),
          },
        });

        if (response.ok) return response;

        if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
          const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
          const backoff = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt;
          logger.warn('http retry', { url, status: response.status, backoffMs: backoff });
          await sleep(backoff);
          continue;
        }

        throw new HttpStatusError(response.status, response.statusText, url);
      } catch (error) {
        lastError = error;

        // A 404 or 403 will not become a 200 by trying again.
        if (error instanceof HttpStatusError && !RETRYABLE_STATUS.has(error.status)) break;

        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (attempt >= maxRetries) break;
        logger.warn('http request failed, retrying', {
          url,
          attempt: attempt + 1,
          reason: isAbort ? `timeout after ${timeoutMs}ms` : String(error),
        });
        await sleep(1000 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    async getText(url, init) {
      const response = await request(url, init);
      return response.text();
    },
    async getJson<T>(url: string, init?: RequestInit): Promise<T> {
      const response = await request(url, init);
      const text = await response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SourceError('http', `expected JSON from ${url} but received ${text.slice(0, 120)}`);
      }
    },
  };
}
