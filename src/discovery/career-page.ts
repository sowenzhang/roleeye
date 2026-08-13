import type { DiscoveredJob, EmploymentType, RawSalary, SalaryPeriod, WorkArrangement } from '../core/types.js';
import { SourceError } from '../util/errors.js';
import { toIso } from '../util/time.js';
import { decodeHtmlEntities, normalizeInlineText } from '../normalize/text.js';
import { detectApplicationSystem } from '../normalize/url.js';
import type { AdapterContext, JobSourceAdapter } from './source-adapter.js';
import type { SourceConfig } from '../config/schema.js';
import { renderWithBrowser } from './browser.js';

type CareerPageConfig = Extract<SourceConfig, { type: 'career-page' }>;

/**
 * Generic career-page adapter.
 *
 * It reads schema.org `JobPosting` JSON-LD, which is the only structured data
 * commonly present on hand-built career pages. Guessing structure from arbitrary
 * markup produces silently wrong records, so anything else is reported as an
 * unsupported page rather than parsed heuristically.
 */

interface JsonLdSalaryValue {
  '@type'?: string;
  value?: number | string;
  minValue?: number | string;
  maxValue?: number | string;
  unitText?: string;
  currency?: string;
}

interface JsonLdJobPosting {
  '@type'?: string | string[];
  identifier?: unknown;
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string | string[];
  jobLocationType?: string;
  url?: string;
  hiringOrganization?: { name?: string; sameAs?: string } | string;
  jobLocation?: unknown;
  applicantLocationRequirements?: unknown;
  baseSalary?: { '@type'?: string; currency?: string; value?: JsonLdSalaryValue | number | string };
}

const SCRIPT_BLOCK = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Extracts every JSON-LD block, tolerating the malformed ones sites ship. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];

  for (const match of html.matchAll(SCRIPT_BLOCK)) {
    const raw = match[1];
    if (!raw) continue;

    const text = decodeHtmlEntities(raw.trim()).replace(/^\uFEFF/, '');
    if (text.length === 0) continue;

    try {
      blocks.push(JSON.parse(text));
    } catch {
      // A broken block on a page must not lose the valid ones.
    }
  }

  return blocks;
}

function isJobPosting(value: unknown): value is JsonLdJobPosting {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as JsonLdJobPosting)['@type'];
  if (typeof type === 'string') return type.toLowerCase() === 'jobposting';
  if (Array.isArray(type)) return type.some((entry) => String(entry).toLowerCase() === 'jobposting');
  return false;
}

/** Walks graphs, arrays, and nested containers to find every JobPosting node. */
export function collectJobPostings(node: unknown, depth = 0): JsonLdJobPosting[] {
  if (depth > 6 || node === null || typeof node !== 'object') return [];

  if (Array.isArray(node)) {
    return node.flatMap((entry) => collectJobPostings(entry, depth + 1));
  }

  const found: JsonLdJobPosting[] = [];
  if (isJobPosting(node)) found.push(node as JsonLdJobPosting);

  const record = node as Record<string, unknown>;
  for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity', 'hasPart']) {
    if (record[key] !== undefined) found.push(...collectJobPostings(record[key], depth + 1));
  }

  return found;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return normalizeInlineText(value) || undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function locationOf(posting: JsonLdJobPosting): { text: string | undefined; remote: boolean } {
  const remote = (posting.jobLocationType ?? '').toLowerCase().includes('telecommute');

  const parts: string[] = [];
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 4 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry, depth + 1));
      return;
    }

    const record = node as Record<string, unknown>;
    const address = record['address'] ?? record;
    if (typeof address === 'object' && address !== null) {
      const fields = address as Record<string, unknown>;
      const city = textOf(fields['addressLocality']);
      const region = textOf(fields['addressRegion']);
      const country = textOf(fields['addressCountry']) ?? textOf((fields['addressCountry'] as Record<string, unknown>)?.['name']);
      const line = [city, region, country].filter(Boolean).join(', ');
      if (line.length > 0) parts.push(line);
    }
    if (record['name'] !== undefined && parts.length === 0) {
      const name = textOf(record['name']);
      if (name) parts.push(name);
    }
  };

  visit(posting.jobLocation);
  if (parts.length === 0 && remote) parts.push('Remote');

  return { text: parts.length > 0 ? [...new Set(parts)].join(' / ') : undefined, remote };
}

function employmentTypeOf(posting: JsonLdJobPosting): EmploymentType | undefined {
  const raw = Array.isArray(posting.employmentType) ? posting.employmentType[0] : posting.employmentType;
  const value = (raw ?? '').toString().toUpperCase().replace(/[\s_-]/g, '');
  if (value.includes('FULLTIME')) return 'full-time';
  if (value.includes('PARTTIME')) return 'part-time';
  if (value.includes('CONTRACT') || value.includes('TEMPORARY')) return 'contract';
  if (value.includes('INTERN')) return 'internship';
  return undefined;
}

const UNIT_TO_PERIOD: Record<string, SalaryPeriod> = {
  YEAR: 'year',
  MONTH: 'month',
  WEEK: 'week',
  DAY: 'day',
  HOUR: 'hour',
};

function salaryOf(posting: JsonLdJobPosting): RawSalary | undefined {
  const base = posting.baseSalary;
  if (!base) return undefined;

  const currency = base.currency ?? 'USD';
  const value = base.value;

  const toNumber = (input: unknown): number | undefined => {
    const parsed = typeof input === 'string' ? Number.parseFloat(input) : typeof input === 'number' ? input : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  if (typeof value === 'object' && value !== null) {
    const min = toNumber(value.minValue) ?? toNumber(value.value);
    const max = toNumber(value.maxValue) ?? toNumber(value.value) ?? min;
    if (min === undefined || max === undefined) return undefined;

    return {
      min: Math.min(min, max),
      max: Math.max(min, max),
      currency,
      period: UNIT_TO_PERIOD[(value.unitText ?? '').toUpperCase()] ?? 'year',
    };
  }

  const single = toNumber(value);
  return single === undefined ? undefined : { min: single, max: single, currency, period: 'year' };
}

export interface CareerPageParseResult {
  jobs: DiscoveredJob[];
  /** Known ATS boards linked from the page, so the user can configure them directly. */
  atsHints: string[];
}

const ATS_LINK = /https?:\/\/[^\s"'<>]*(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com)[^\s"'<>]*/gi;

export function findAtsHints(html: string): string[] {
  const hints = new Set<string>();
  for (const match of html.matchAll(ATS_LINK)) {
    const system = detectApplicationSystem(match[0]);
    if (system) hints.add(system);
  }
  return [...hints];
}

export function parseCareerPage(html: string, config: CareerPageConfig, pageUrl: string): CareerPageParseResult {
  const postings = extractJsonLdBlocks(html).flatMap((block) => collectJobPostings(block));

  const jobs = postings.flatMap((posting): DiscoveredJob[] => {
    const title = normalizeInlineText(posting.title ?? '');
    const url = textOf(posting.url) ?? pageUrl;
    if (!title) return [];

    const location = locationOf(posting);
    const salary = salaryOf(posting);
    const employmentType = employmentTypeOf(posting);
    const arrangement: WorkArrangement | undefined = location.remote ? 'remote' : undefined;

    const organization =
      typeof posting.hiringOrganization === 'string'
        ? posting.hiringOrganization
        : posting.hiringOrganization?.name;

    return [
      {
        sourceType: 'career-page',
        sourceName: config.name,
        sourceJobId: typeof posting.identifier === 'string' ? posting.identifier : undefined,
        companyName: normalizeInlineText(organization ?? '') || config.company,
        title,
        location: location.text,
        url,
        applyUrl: url,
        descriptionHtml: posting.description,
        ...(arrangement ? { workArrangement: arrangement } : {}),
        ...(employmentType ? { employmentType } : {}),
        ...(salary ? { salary } : {}),
        postedAt: toIso(posting.datePosted),
        rawPayload: posting,
      },
    ];
  });

  return { jobs, atsHints: findAtsHints(html) };
}

export class CareerPageAdapter implements JobSourceAdapter<CareerPageConfig> {
  readonly name = 'career-page' as const;

  async scan(config: CareerPageConfig, context: AdapterContext): Promise<DiscoveredJob[]> {
    context.logger.debug('fetching career page', { url: config.url });

    let html: string;
    try {
      html = await context.http.getText(config.url);
    } catch (error) {
      throw new SourceError(config.name, `career page fetch failed: ${String(error)}`, { url: config.url });
    }

    let result = parseCareerPage(html, config, config.url);

    // Client-rendered boards return a shell; the browser fallback is opt-in.
    if (result.jobs.length === 0 && config.browser_fallback) {
      context.logger.info('no postings in static html, trying browser fallback', { url: config.url });
      const rendered = await renderWithBrowser(config.url, context.logger);
      result = parseCareerPage(rendered, config, config.url);
    }

    if (result.jobs.length === 0) {
      const hint =
        result.atsHints.length > 0
          ? ` The page links to ${result.atsHints.join(', ')}; configure that source type directly for reliable results.`
          : config.browser_fallback
            ? ''
            : ' If the page renders postings with JavaScript, set browser_fallback: true.';

      throw new SourceError(
        config.name,
        `no schema.org JobPosting data found at ${config.url}.${hint}`,
        { url: config.url },
      );
    }

    return result.jobs;
  }
}
