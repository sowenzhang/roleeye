import type { DiscoveredJob } from '../core/types.js';
import { SourceError, UsageError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { canonicalizeUrl, detectApplicationSystem } from '../normalize/url.js';
import { parseGreenhouseBoard, type GreenhouseBoardResponse } from './greenhouse.js';
import { parseLeverPostings } from './lever.js';
import { parseAshbyBoard, jobBoardUrl, type AshbyBoardResponse } from './ashby.js';
import { parseCareerPage } from './career-page.js';
import type { HttpClient } from './source-adapter.js';

/**
 * Captures a single posting from a URL.
 *
 * Adapters cover a company's whole board; this covers the role someone sends
 * you. Where an ATS exposes a single-posting endpoint we use it, because the
 * structured record is far more reliable than scraping the rendered page.
 */

export interface CaptureOptions {
  http: HttpClient;
  logger: Logger;
  /** Overrides the company name when the source does not state one. */
  company?: string | undefined;
  sourceName?: string | undefined;
}

interface GreenhouseRef {
  board: string;
  jobId: string;
}

export function parseGreenhouseUrl(url: URL): GreenhouseRef | undefined {
  if (!url.hostname.includes('greenhouse.io')) return undefined;

  // boards.greenhouse.io/<board>/jobs/<id> and job-boards.greenhouse.io/<board>/jobs/<id>
  const match = /^\/(?:embed\/job_app\?for=)?([^/]+)\/jobs\/(\d+)/.exec(url.pathname);
  if (match?.[1] && match[2]) return { board: match[1], jobId: match[2] };

  const embedBoard = url.searchParams.get('for');
  const embedId = url.searchParams.get('token') ?? url.searchParams.get('gh_jid');
  if (embedBoard && embedId) return { board: embedBoard, jobId: embedId };

  return undefined;
}

export function parseLeverUrl(url: URL): { site: string; jobId: string } | undefined {
  if (!url.hostname.includes('lever.co')) return undefined;

  const match = /^\/([^/]+)\/([0-9a-f-]{16,})/i.exec(url.pathname);
  if (match?.[1] && match[2]) return { site: match[1], jobId: match[2] };
  return undefined;
}

export function parseAshbyUrl(url: URL): { board: string; jobId: string } | undefined {
  if (!url.hostname.includes('ashbyhq.com')) return undefined;

  const match = /^\/([^/]+)\/([0-9a-f-]{16,})/i.exec(url.pathname);
  if (match?.[1] && match[2]) return { board: match[1], jobId: match[2] };
  return undefined;
}

async function captureGreenhouse(ref: GreenhouseRef, options: CaptureOptions): Promise<DiscoveredJob[]> {
  const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ref.board)}/jobs/${encodeURIComponent(ref.jobId)}`;
  const job = await options.http.getJson<Record<string, unknown>>(endpoint);

  return parseGreenhouseBoard({ jobs: [job] } as GreenhouseBoardResponse, {
    name: options.sourceName ?? `manual:${ref.board}`,
    type: 'greenhouse',
    enabled: true,
    company: options.company ?? ref.board,
    board: ref.board,
  });
}

async function captureLever(ref: { site: string; jobId: string }, options: CaptureOptions): Promise<DiscoveredJob[]> {
  const endpoint = `https://api.lever.co/v0/postings/${encodeURIComponent(ref.site)}/${encodeURIComponent(ref.jobId)}`;
  const posting = await options.http.getJson<unknown>(endpoint);

  return parseLeverPostings([posting], {
    name: options.sourceName ?? `manual:${ref.site}`,
    type: 'lever',
    enabled: true,
    company: options.company ?? ref.site,
    site: ref.site,
  });
}

/** Ashby has no single-posting endpoint, so the board is filtered by job id. */
async function captureAshby(ref: { board: string; jobId: string }, options: CaptureOptions): Promise<DiscoveredJob[]> {
  const payload = await options.http.getJson<AshbyBoardResponse>(jobBoardUrl(ref.board));

  const jobs = parseAshbyBoard(payload, {
    name: options.sourceName ?? `manual:${ref.board}`,
    type: 'ashby',
    enabled: true,
    company: options.company ?? ref.board,
    board: ref.board,
  });

  const matched = jobs.filter((job) => job.sourceJobId === ref.jobId || job.url.includes(ref.jobId));
  return matched.length > 0 ? matched : [];
}

async function captureGeneric(url: URL, options: CaptureOptions): Promise<DiscoveredJob[]> {
  const html = await options.http.getText(url.toString());

  const result = parseCareerPage(
    html,
    {
      name: options.sourceName ?? 'manual',
      type: 'career-page',
      enabled: true,
      company: options.company ?? url.hostname,
      url: url.toString(),
      browser_fallback: false,
    },
    url.toString(),
  );

  if (result.jobs.length === 0) {
    const hint =
      result.atsHints.length > 0
        ? ` The page links to ${result.atsHints.join(', ')}; try the direct posting URL on that system.`
        : '';
    throw new SourceError('add', `no structured job data found at ${url.toString()}.${hint}`);
  }

  return result.jobs;
}

/**
 * Resolves a posting URL to discovered jobs. The HTTP client applies the URL
 * guard, so a hostile link cannot reach a private address.
 */
export async function captureFromUrl(rawUrl: string, options: CaptureOptions): Promise<DiscoveredJob[]> {
  const canonical = canonicalizeUrl(rawUrl);
  if (!canonical) throw new UsageError(`not a usable http(s) URL: ${rawUrl}`);

  const url = new URL(canonical);
  options.logger.debug('capturing url', { host: url.hostname, system: detectApplicationSystem(canonical) });

  const greenhouse = parseGreenhouseUrl(url);
  if (greenhouse) return captureGreenhouse(greenhouse, options);

  const lever = parseLeverUrl(url);
  if (lever) return captureLever(lever, options);

  const ashby = parseAshbyUrl(url);
  if (ashby) return captureAshby(ashby, options);

  return captureGeneric(url, options);
}
