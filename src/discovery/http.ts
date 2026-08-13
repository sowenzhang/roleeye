import { SourceError } from '../util/errors.js';
import { sleep } from '../util/time.js';
import { redactUrl, type Logger } from '../util/logger.js';
import { assertUrlAllowed, BlockedRequestError } from './url-guard.js';
import type { HttpClient } from './source-adapter.js';

export interface HttpClientOptions {
  userAgent: string;
  timeoutMs: number;
  /** Minimum delay between requests. Politeness is a hard requirement. */
  delayMs: number;
  maxRetries?: number;
  /** Response size ceiling. A source must not be able to exhaust memory or disk. */
  maxBytes?: number;
  /** Redirect hops to follow, each re-validated against the URL guard. */
  maxRedirects?: number;
  allowInsecure?: boolean;
  logger: Logger;
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, url: string) {
    super(`HTTP ${status} ${statusText} for ${redactUrl(url)}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/**
 * Rate-limited fetch wrapper with bounded retries, bounded response size, and
 * per-hop redirect validation.
 *
 * We deliberately respect Retry-After and never attempt to evade rate limits or
 * authentication (agent.md discovery rules).
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const {
    userAgent,
    timeoutMs,
    delayMs,
    maxRetries = 2,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = 3,
    logger,
  } = options;
  const doFetch = options.fetchImpl ?? fetch;
  let nextAllowedAt = 0;

  const guardOptions = {
    ...(options.allowInsecure === undefined ? {} : { allowInsecure: options.allowInsecure }),
    ...(options.resolveHost === undefined ? {} : { resolve: options.resolveHost }),
  };

  async function throttle(): Promise<void> {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextAllowedAt = Date.now() + delayMs;
  }

  /** One attempt, following redirects manually so every hop is re-checked. */
  async function attempt(startUrl: string, init?: RequestInit): Promise<Response> {
    let currentUrl = startUrl;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      await assertUrlAllowed(currentUrl, guardOptions);
      await throttle();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await doFetch(currentUrl, {
          ...init,
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: 'application/json, text/html;q=0.9, */*;q=0.8',
            'user-agent': userAgent,
            ...(init?.headers ?? {}),
          },
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new HttpStatusError(response.status, 'redirect without location', currentUrl);
        if (hop === maxRedirects) throw new BlockedRequestError(`too many redirects from ${redactUrl(startUrl)}`);

        currentUrl = new URL(location, currentUrl).toString();
        logger.debug('following redirect', { to: redactUrl(currentUrl) });
        continue;
      }

      if (!response.ok) throw new HttpStatusError(response.status, response.statusText, currentUrl);

      const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new SourceError('http', `response from ${redactUrl(currentUrl)} exceeds ${maxBytes} bytes`);
      }

      return response;
    }

    throw new BlockedRequestError(`too many redirects from ${redactUrl(startUrl)}`);
  }

  async function request(url: string, init?: RequestInit): Promise<string> {
    let lastError: unknown;

    for (let tries = 0; tries <= maxRetries; tries += 1) {
      try {
        const response = await attempt(url, init);
        return await readCapped(response, maxBytes, url);
      } catch (error) {
        lastError = error;

        // A blocked URL or a 404 will not become valid by trying again.
        if (error instanceof BlockedRequestError) break;
        if (error instanceof HttpStatusError && !RETRYABLE_STATUS.has(error.status)) break;
        if (tries >= maxRetries) break;

        const isAbort = error instanceof Error && error.name === 'AbortError';
        logger.warn('http request failed, retrying', {
          url: redactUrl(url),
          attempt: tries + 1,
          reason: isAbort ? `timeout after ${timeoutMs}ms` : String(error),
        });
        await sleep(1000 * 2 ** tries);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    async getText(url, init) {
      return request(url, init);
    },
    async getJson<T>(url: string, init?: RequestInit): Promise<T> {
      const text = await request(url, init);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SourceError('http', `expected JSON from ${redactUrl(url)} but received ${text.slice(0, 120)}`);
      }
    },
  };
}

/** Reads a body while enforcing the size ceiling, even without Content-Length. */
async function readCapped(response: Response, maxBytes: number, url: string): Promise<string> {
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new SourceError('http', `response from ${redactUrl(url)} exceeds ${maxBytes} bytes`);
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
  } finally {
    reader.releaseLock();
  }

  chunks.push(decoder.decode());
  return chunks.join('');
}
