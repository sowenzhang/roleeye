import type { DiscoveredJob, EmploymentType, RawSalary, SalaryPeriod, WorkArrangement } from '../core/types.js';
import { SourceError } from '../util/errors.js';
import { toIso } from '../util/time.js';
import { normalizeInlineText } from '../normalize/text.js';
import type { AdapterContext, JobSourceAdapter } from './source-adapter.js';
import type { SourceConfig } from '../config/schema.js';

type LeverConfig = Extract<SourceConfig, { type: 'lever' }>;

export interface LeverList {
  text?: string;
  content?: string;
}

export interface LeverPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  country?: string;
  description?: string;
  descriptionPlain?: string;
  additional?: string;
  lists?: LeverList[];
  categories?: {
    commitment?: string;
    department?: string;
    team?: string;
    location?: string;
    allLocations?: string[];
  };
  salaryRange?: {
    currency?: string;
    interval?: string;
    min?: number;
    max?: number;
  };
}

export function postingsUrl(site: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`;
}

/** Lever splits the body across `description`, `lists`, and `additional`. */
function descriptionOf(posting: LeverPosting): string | undefined {
  const parts: string[] = [];

  if (posting.description) parts.push(posting.description);

  for (const list of posting.lists ?? []) {
    if (list.text) parts.push(`<h3>${list.text}</h3>`);
    if (list.content) parts.push(`<ul>${list.content}</ul>`);
  }

  if (posting.additional) parts.push(posting.additional);

  const combined = parts.join('\n');
  return combined.trim().length > 0 ? combined : undefined;
}

const INTERVAL_TO_PERIOD: Record<string, SalaryPeriod> = {
  'per-year-salary': 'year',
  'per-month-salary': 'month',
  'per-week-salary': 'week',
  'per-day-salary': 'day',
  'per-hour-wage': 'hour',
};

function salaryOf(posting: LeverPosting): RawSalary | undefined {
  const range = posting.salaryRange;
  if (!range || (range.min === undefined && range.max === undefined)) return undefined;

  return {
    min: range.min ?? range.max,
    max: range.max ?? range.min,
    currency: range.currency ?? 'USD',
    period: INTERVAL_TO_PERIOD[range.interval ?? ''] ?? 'year',
  };
}

function employmentTypeOf(posting: LeverPosting): EmploymentType | undefined {
  const commitment = posting.categories?.commitment?.toLowerCase();
  if (!commitment) return undefined;
  if (commitment.includes('full')) return 'full-time';
  if (commitment.includes('part')) return 'part-time';
  if (commitment.includes('contract') || commitment.includes('temporary')) return 'contract';
  if (commitment.includes('intern')) return 'internship';
  return undefined;
}

/** Lever states the arrangement explicitly, which is better than inferring it. */
function locationOf(posting: LeverPosting): { text: string | undefined; arrangement: WorkArrangement | undefined } {
  const all = (posting.categories?.allLocations ?? [])
    .map((entry) => normalizeInlineText(entry))
    .filter((entry) => entry.length > 0);
  const primary = normalizeInlineText(posting.categories?.location ?? '');

  const text = all.length > 0 ? [...new Set([primary, ...all])].filter(Boolean).join(' / ') : primary || undefined;

  const workplace = posting.workplaceType?.toLowerCase();
  const arrangement: WorkArrangement | undefined =
    workplace === 'remote' ? 'remote' : workplace === 'hybrid' ? 'hybrid' : workplace === 'onsite' ? 'onsite' : undefined;

  return { text: text && text.length > 0 ? text : undefined, arrangement };
}

/** Pure mapping so fixture tests run without network access. */
export function parseLeverPostings(payload: unknown, config: LeverConfig): DiscoveredJob[] {
  if (!Array.isArray(payload)) {
    throw new SourceError(config.name, `lever site "${config.site}" returned an unexpected payload`);
  }

  return (payload as LeverPosting[]).flatMap((posting): DiscoveredJob[] => {
    const title = normalizeInlineText(posting.text ?? '');
    const url = posting.hostedUrl?.trim() ?? posting.applyUrl?.trim();
    if (!title || !url) return [];

    const location = locationOf(posting);
    const salary = salaryOf(posting);
    const employmentType = employmentTypeOf(posting);

    return [
      {
        sourceType: 'lever',
        sourceName: config.name,
        sourceJobId: posting.id,
        companyName: config.company,
        title,
        location: location.text,
        url,
        applyUrl: posting.applyUrl ?? url,
        descriptionHtml: descriptionOf(posting),
        department: normalizeInlineText(posting.categories?.department ?? '') || undefined,
        team: normalizeInlineText(posting.categories?.team ?? '') || undefined,
        workArrangement: location.arrangement,
        ...(employmentType ? { employmentType } : {}),
        ...(salary ? { salary } : {}),
        postedAt: toIso(posting.createdAt),
        rawPayload: posting,
      },
    ];
  });
}

export class LeverAdapter implements JobSourceAdapter<LeverConfig> {
  readonly name = 'lever' as const;

  async scan(config: LeverConfig, context: AdapterContext): Promise<DiscoveredJob[]> {
    const url = postingsUrl(config.site);
    context.logger.debug('fetching lever postings', { site: config.site });

    let payload: unknown;
    try {
      payload = await context.http.getJson<unknown>(url);
    } catch (error) {
      throw new SourceError(config.name, `lever site "${config.site}" fetch failed: ${String(error)}`, { url });
    }

    return parseLeverPostings(payload, config);
  }
}
