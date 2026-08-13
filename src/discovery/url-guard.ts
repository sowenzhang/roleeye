import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Blocks requests that would reach the machine itself or its private network.
 *
 * Source URLs come from user-edited YAML and, once career-page adapters exist,
 * from arbitrary third-party sites that may redirect. Without this check a
 * posting page could redirect the scanner to a cloud metadata endpoint or a
 * local service and have the response body stored in the database.
 */

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  const [a, b] = parts;
  if (a === undefined || b === undefined || parts.some((part) => Number.isNaN(part))) return true;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, includes cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true;
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // unique local
  if (value.startsWith('fe80')) return true; // link local
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice(7);
    return isIP(mapped) === 4 ? isPrivateIPv4(mapped) : true;
  }
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

export class BlockedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedRequestError';
  }
}

export interface UrlGuardOptions {
  /** Allow http:// as well as https://. Off by default. */
  allowInsecure?: boolean;
  /** Injectable for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((entry) => entry.address);
}

/**
 * Validates a URL before it is fetched. Every redirect hop is re-validated,
 * because only the first hop is under our control.
 */
export async function assertUrlAllowed(rawUrl: string, options: UrlGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedRequestError(`invalid URL: ${rawUrl}`);
  }

  const allowedProtocols = options.allowInsecure ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new BlockedRequestError(`blocked ${url.protocol}// request (https required): ${url.hostname}`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname.length === 0) throw new BlockedRequestError('blocked request with empty host');

  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new BlockedRequestError(`blocked request to private address ${hostname}`);
    }
    return url;
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new BlockedRequestError(`blocked request to local host ${hostname}`);
  }

  const resolve = options.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    throw new BlockedRequestError(`could not resolve ${hostname}: ${String(error)}`);
  }

  if (addresses.length === 0) throw new BlockedRequestError(`no addresses for ${hostname}`);

  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedRequestError(`blocked request to ${hostname} which resolves to private address ${address}`);
    }
  }

  return url;
}
