import type { DiscoveredJob } from '../core/types.js';
import { SourceError } from '../util/errors.js';
import { toIso } from '../util/time.js';
import { decodeHtmlEntities } from '../normalize/text.js';
import type { AdapterContext, JobSourceAdapter } from './source-adapter.js';
import type { SourceConfig } from '../config/schema.js';

type GreenhouseConfig = Extract<SourceConfig, { type: 'greenhouse' }>;

export interface GreenhouseJob {
  id?: number | string;
  internal_job_id?: number | string;
  requisition_id?: string;
  title?: string;
  updated_at?: string;
  first_published?: string;
  absolute_url?: string;
  location?: { name?: string } | null;
  offices?: Array<{ name?: string; location?: string }> | null;
  departments?: Array<{ name?: string }> | null;
  metadata?: Array<{ name?: string; value?: unknown }> | null;
  content?: string;
}

export interface GreenhouseBoardResponse {
  jobs?: GreenhouseJob[];
  meta?: { total?: number };
}

export function boardUrl(board: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`;
}

function locationOf(job: GreenhouseJob): string | undefined {
  const primary = job.location?.name?.trim();
  if (primary) return primary;

  const offices = (job.offices ?? [])
    .map((office) => office?.name?.trim() ?? office?.location?.trim())
    .filter((value): value is string => Boolean(value) && value !== 'No Office');

  return offices.length > 0 ? offices.join(' / ') : undefined;
}

/**
 * Greenhouse returns the posting body as HTML-escaped HTML, so it must be
 * unescaped once before the normalizer converts markup to text.
 */
function descriptionOf(job: GreenhouseJob): string | undefined {
  const content = job.content?.trim();
  if (!content) return undefined;
  return decodeHtmlEntities(content);
}

/** Pure mapping from an API payload to adapter output, so fixtures can test it offline. */
export function parseGreenhouseBoard(
  payload: GreenhouseBoardResponse,
  config: GreenhouseConfig,
): DiscoveredJob[] {
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];

  return jobs.flatMap((job): DiscoveredJob[] => {
    const title = job.title?.replace(/\s+/g, ' ').trim();
    const url = job.absolute_url?.trim();
    if (!title || !url) return [];

    const sourceJobId = job.id !== undefined ? String(job.id) : undefined;

    return [
      {
        sourceType: 'greenhouse',
        sourceName: config.name,
        sourceJobId,
        companyName: config.company,
        title,
        location: locationOf(job),
        url,
        applyUrl: url,
        descriptionHtml: descriptionOf(job),
        postedAt: toIso(job.first_published ?? job.updated_at),
        rawPayload: job,
      },
    ];
  });
}

export class GreenhouseAdapter implements JobSourceAdapter<GreenhouseConfig> {
  readonly name = 'greenhouse' as const;

  async scan(config: GreenhouseConfig, context: AdapterContext): Promise<DiscoveredJob[]> {
    const url = boardUrl(config.board);
    context.logger.debug('fetching greenhouse board', { board: config.board, url });

    let payload: GreenhouseBoardResponse;
    try {
      payload = await context.http.getJson<GreenhouseBoardResponse>(url);
    } catch (error) {
      throw new SourceError(config.name, `greenhouse board "${config.board}" fetch failed: ${String(error)}`, {
        url,
      });
    }

    if (!payload || !Array.isArray(payload.jobs)) {
      throw new SourceError(config.name, `greenhouse board "${config.board}" returned an unexpected payload`, {
        url,
      });
    }

    return parseGreenhouseBoard(payload, config);
  }
}
