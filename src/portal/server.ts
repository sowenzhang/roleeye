import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../util/logger.js';

/**
 * A localhost-only HTTP server for the configuration portal.
 *
 * Written on node:http rather than a framework: the portal has a handful of
 * endpoints and no business logic of its own, and a dependency-free server is
 * easier to audit for a tool that holds someone's entire job search.
 *
 * Security posture (architecture.md §39, §40):
 * - binds 127.0.0.1 only, never 0.0.0.0
 * - state-changing requests must carry a token minted at start
 * - requests from a foreign origin are refused, so a page in another tab
 *   cannot drive the agent
 */

export type RouteHandler = (context: RequestContext) => Promise<RouteResult> | RouteResult;

export interface RequestContext {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: unknown;
  logger: Logger;
}

export interface RouteResult {
  status: number;
  json?: unknown;
  html?: string;
  contentType?: string;
  body?: string;
}

export interface PortalServerOptions {
  port: number;
  host?: string;
  logger: Logger;
  routes: Record<string, RouteHandler>;
  /** Serves the single-page app for any unmatched GET. */
  index: () => string;
}

export interface RunningPortal {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
  server: Server;
}

const MAX_BODY_BYTES = 1_000_000;

/** Only loopback literals are acceptable; a hostname could resolve anywhere. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const withoutPort = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return withoutPort === '127.0.0.1' || withoutPort === 'localhost' || withoutPort === '::1';
}

/**
 * Rejects cross-origin writes.
 *
 * Without this, any page the user has open in another tab could POST to the
 * portal and rewrite their configuration.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // Same-origin fetch and curl send no Origin header.

  try {
    const url = new URL(origin);
    return isLoopbackHost(url.hostname) && (url.port === String(port) || url.port === '');
  } catch {
    return false;
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }

  if (chunks.length === 0) return undefined;

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('request body must be JSON');
  }
}

export function startPortal(options: PortalServerOptions): Promise<RunningPortal> {
  const host = options.host ?? '127.0.0.1';
  const token = randomBytes(24).toString('hex');
  const { logger } = options;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.error('portal request failed', { error: String(error) });
      send(response, { status: 500, json: { error: 'internal error' } });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const method = request.method ?? 'GET';
    const port = (server.address() as AddressInfo | null)?.port ?? options.port;

    if (!isLoopbackHost(request.headers.host)) {
      send(response, { status: 403, json: { error: 'this portal only serves localhost' } });
      return;
    }

    if (!isAllowedOrigin(request.headers.origin, port)) {
      send(response, { status: 403, json: { error: 'cross-origin requests are refused' } });
      return;
    }

    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating && request.headers['x-roleeye-token'] !== token) {
      send(response, { status: 403, json: { error: 'missing or invalid portal token' } });
      return;
    }

    const handler = options.routes[`${method} ${url.pathname}`];
    if (handler) {
      let body: unknown;
      try {
        body = mutating ? await readBody(request) : undefined;
      } catch (error) {
        send(response, { status: 400, json: { error: error instanceof Error ? error.message : String(error) } });
        return;
      }

      const result = await handler({ method, pathname: url.pathname, query: url.searchParams, body, logger });
      send(response, result);
      return;
    }

    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      send(response, { status: 200, html: options.index() });
      return;
    }

    send(response, { status: 404, json: { error: 'not found' } });
  }

  function send(response: ServerResponse, result: RouteResult): void {
    const headers: Record<string, string> = {
      // The portal renders third-party job text; keep it from reaching anywhere.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    };

    if (result.html !== undefined) {
      response.writeHead(result.status, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      response.end(result.html);
      return;
    }

    if (result.body !== undefined) {
      response.writeHead(result.status, {
        ...headers,
        'content-type': result.contentType ?? 'text/plain; charset=utf-8',
      });
      response.end(result.body);
      return;
    }

    response.writeHead(result.status, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(result.json ?? {}, null, 2));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://${host}:${address.port}/?token=${token}`,
        port: address.port,
        token,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
