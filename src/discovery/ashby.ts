import type { DiscoveredJob, EmploymentType, RawSalary, SalaryPeriod, WorkArrangement } from '../core/types.js';
import { SourceError } from '../util/errors.js';
import { toIso } from '../util/time.js';
import { normalizeInlineText } from '../normalize/text.js';
import type { AdapterContext, JobSourceAdapter } from './source-adapter.js';
import type { SourceConfig } from '../config/schema.js';

type AshbyConfig = Extract<SourceConfig, { type: 'ashby' }>;

interface AshbyCompensationComponent {
  compensationType?: string;
  interval?: string;
  currencyCode?: string;
  minValue?: number;
  maxValue?: number;
  summary?: string;
}

interface AshbyCompensationTier {
  id?: string;
  title?: string;
  additionalInformation?: string | null;
  components?: AshbyCompensationComponent[];
}

export interface AshbyJob {
  id?: string;
  title?: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  address?: unknown;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTierSummary?: string;
    scrapeableCompensationSalarySummary?: string;
    compensationTiers?: AshbyCompensationTier[];
  };
}

export interface AshbyBoardResponse {
  apiVersion?: string;
  jobs?: AshbyJob[];
}

export function jobBoardUrl(board: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;
}

const INTERVAL_TO_PERIOD: Record<string, SalaryPeriod> = {
  YEAR: 'year',
  MONTH: 'month',
  WEEK: 'week',
  DAY: 'day',
  HOUR: 'hour',
  'PER YEAR': 'year',
  'PER HOUR': 'hour',
};

/**
 * Ashby reports compensation as tiers of components. Only salary components are
 * usable; equity and bonus components would corrupt a salary threshold check.
 */
function salaryOf(job: AshbyJob): RawSalary | undefined {
  const tiers = job.compensation?.compensationTiers ?? [];

  for (const tier of tiers) {
    for (const component of tier.components ?? []) {
      const type = component.compensationType?.toUpperCase();
      if (type !== 'SALARY') continue;
      if (component.minValue === undefined && component.maxValue === undefined) continue;

      const min = component.minValue ?? component.maxValue;
      const max = component.maxValue ?? component.minValue;
      if (min === undefined || max === undefined) continue;

      return {
        min: Math.min(min, max),
        max: Math.max(min, max),
        currency: component.currencyCode ?? 'USD',
        period: INTERVAL_TO_PERIOD[(component.interval ?? '').toUpperCase()] ?? 'year',
        text: component.summary,
      };
    }
  }

  const summary = job.compensation?.scrapeableCompensationSalarySummary ?? job.compensation?.compensationTierSummary;
  return summary ? { text: summary } : undefined;
}

function employmentTypeOf(job: AshbyJob): EmploymentType | undefined {
  const value = job.employmentType?.toLowerCase();
  if (!value) return undefined;
  if (value.includes('fulltime') || value.includes('full')) return 'full-time';
  if (value.includes('parttime') || value.includes('part')) return 'part-time';
  if (value.includes('contract') || value.includes('temporary')) return 'contract';
  if (value.includes('intern')) return 'internship';
  return undefined;
}

function locationOf(job: AshbyJob): string | undefined {
  const primary = normalizeInlineText(job.location ?? '');
  const secondary = (job.secondaryLocations ?? [])
    .map((entry) => normalizeInlineText(entry?.location ?? ''))
    .filter((entry) => entry.length > 0);

  const combined = [...new Set([primary, ...secondary])].filter((entry) => entry.length > 0);
  return combined.length > 0 ? combined.join(' / ') : undefined;
}

function arrangementOf(job: AshbyJob): WorkArrangement | undefined {
  const workplace = job.workplaceType?.toLowerCase();
  if (workplace === 'remote') return 'remote';
  if (workplace === 'hybrid') return 'hybrid';
  if (workplace === 'onsite' || workplace === 'inoffice') return 'onsite';
  return job.isRemote === true ? 'remote' : undefined;
}

/** Pure mapping so fixture tests run without network access. */
export function parseAshbyBoard(payload: AshbyBoardResponse, config: AshbyConfig): DiscoveredJob[] {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];

  return jobs.flatMap((job): DiscoveredJob[] => {
    // Unlisted postings are drafts or internal; treat them as not published.
    if (job.isListed === false) return [];

    const title = normalizeInlineText(job.title ?? '');
    const url = job.jobUrl?.trim() ?? job.applyUrl?.trim();
    if (!title || !url) return [];

    const salary = salaryOf(job);
    const employmentType = employmentTypeOf(job);
    const arrangement = arrangementOf(job);

    return [
      {
        sourceType: 'ashby',
        sourceName: config.name,
        sourceJobId: job.id,
        companyName: config.company,
        title,
        location: locationOf(job),
        url,
        applyUrl: job.applyUrl ?? url,
        descriptionHtml: job.descriptionHtml,
        description: job.descriptionHtml ? undefined : job.descriptionPlain,
        department: normalizeInlineText(job.department ?? '') || undefined,
        team: normalizeInlineText(job.team ?? '') || undefined,
        ...(arrangement ? { workArrangement: arrangement } : {}),
        ...(employmentType ? { employmentType } : {}),
        ...(salary ? { salary } : {}),
        postedAt: toIso(job.publishedAt),
        rawPayload: job,
      },
    ];
  });
}

export class AshbyAdapter implements JobSourceAdapter<AshbyConfig> {
  readonly name = 'ashby' as const;

  async scan(config: AshbyConfig, context: AdapterContext): Promise<DiscoveredJob[]> {
    const url = jobBoardUrl(config.board);
    context.logger.debug('fetching ashby board', { board: config.board });

    let payload: AshbyBoardResponse;
    try {
      payload = await context.http.getJson<AshbyBoardResponse>(url);
    } catch (error) {
      throw new SourceError(config.name, `ashby board "${config.board}" fetch failed: ${String(error)}`, { url });
    }

    if (!payload || !Array.isArray(payload.jobs)) {
      throw new SourceError(config.name, `ashby board "${config.board}" returned an unexpected payload`, { url });
    }

    return parseAshbyBoard(payload, config);
  }
}
