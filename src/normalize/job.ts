import type {
  DiscoveredJob,
  EmploymentType,
  SalaryPeriod,
  SourceType,
  WorkArrangement,
} from '../core/types.js';
import { normalizeCompanyName } from './company.js';
import { computeFingerprint, descriptionHash, resolveIdentity, type IdentityTier } from './identity.js';
import { normalizeLocation } from './location.js';
import { findSalaryInDescription, parseSalary } from './salary.js';
import { htmlToText, looksLikeHtml, normalizeWhitespace, normalizeInlineText, capDescription } from './text.js';
import { extractLevel, normalizeTitle } from './title.js';
import { canonicalizeUrl, detectApplicationSystem } from './url.js';

export interface NormalizedJob {
  companyName: string;
  normalizedCompanyName: string;
  title: string;
  normalizedTitle: string;
  level: string | undefined;
  employmentType: EmploymentType;
  workArrangement: WorkArrangement;
  locationText: string | undefined;
  country: string | undefined;
  department: string | undefined;
  team: string | undefined;
  salaryMin: number | undefined;
  salaryMax: number | undefined;
  salaryCurrency: string | undefined;
  salaryPeriod: SalaryPeriod | undefined;
  sourceType: SourceType;
  sourceName: string;
  sourceJobId: string | undefined;
  sourceUrl: string;
  canonicalUrl: string | undefined;
  applyUrl: string | undefined;
  applicationSystem: string | undefined;
  descriptionText: string;
  descriptionHash: string;
  identityKey: string;
  identityTier: IdentityTier;
  fingerprint: string;
  postedAt: string | undefined;
  rawPayload: string | undefined;
}

/**
 * Converts adapter output into the canonical shape the ingestion pipeline
 * stores. Pure and deterministic so it can be unit tested against fixtures.
 */
export function normalizeDiscoveredJob(discovered: DiscoveredJob): NormalizedJob {
  const companyName = normalizeInlineText(discovered.companyName);
  const normalizedCompanyName = normalizeCompanyName(companyName);
  const title = normalizeInlineText(discovered.title);

  const descriptionText = extractDescription(discovered);
  const location = normalizeLocation(
    discovered.location === undefined ? undefined : normalizeInlineText(discovered.location),
    descriptionText,
  );

  const canonicalUrl = canonicalizeUrl(discovered.url);
  const applyUrl = canonicalizeUrl(discovered.applyUrl) ?? canonicalUrl;

  const salary =
    normalizeSalary(discovered.salary) ??
    parseSalary(discovered.salary?.text) ??
    findSalaryInDescription(descriptionText);

  const identity = resolveIdentity({
    sourceType: discovered.sourceType,
    sourceJobId: discovered.sourceJobId,
    canonicalUrl,
    applyUrl,
    sourceUrl: discovered.url,
    normalizedCompanyName,
    normalizedTitle: normalizeTitle(title),
    locationText: location.text,
    descriptionText,
  });

  return {
    companyName,
    normalizedCompanyName,
    title,
    normalizedTitle: normalizeTitle(title),
    level: extractLevel(title),
    employmentType: discovered.employmentType ?? 'unknown',
    // A source that states the arrangement is more reliable than our inference.
    workArrangement: discovered.workArrangement ?? location.workArrangement,
    locationText: location.text,
    country: location.country,
    department: discovered.department?.trim() || undefined,
    team: discovered.team?.trim() || undefined,
    salaryMin: salary?.min,
    salaryMax: salary?.max,
    salaryCurrency: salary?.currency,
    salaryPeriod: salary?.period,
    sourceType: discovered.sourceType,
    sourceName: discovered.sourceName,
    sourceJobId: discovered.sourceJobId?.trim() || undefined,
    sourceUrl: canonicalUrl ?? discovered.url,
    canonicalUrl,
    applyUrl,
    applicationSystem: detectApplicationSystem(applyUrl ?? canonicalUrl),
    descriptionText,
    descriptionHash: descriptionHash(descriptionText),
    identityKey: identity.key,
    identityTier: identity.tier,
    fingerprint: identity.fingerprint,
    postedAt: discovered.postedAt,
    rawPayload: serializeRawPayload(discovered.rawPayload),
  };
}

function extractDescription(discovered: DiscoveredJob): string {
  const html = discovered.descriptionHtml?.trim();
  if (html) return capDescription(htmlToText(html));

  const plain = discovered.description?.trim();
  if (!plain) return '';

  return capDescription(looksLikeHtml(plain) ? htmlToText(plain) : normalizeWhitespace(plain));
}

function normalizeSalary(salary: DiscoveredJob['salary']): DiscoveredJob['salary'] | undefined {
  if (!salary) return undefined;
  if (salary.min === undefined && salary.max === undefined) return undefined;

  const min = salary.min ?? salary.max;
  const max = salary.max ?? salary.min;
  if (min === undefined || max === undefined) return undefined;

  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
    currency: salary.currency ?? 'USD',
    period: salary.period ?? 'year',
    text: salary.text,
  };
}

function serializeRawPayload(payload: unknown): string | undefined {
  if (payload === undefined || payload === null) return undefined;
  try {
    return JSON.stringify(payload);
  } catch {
    return undefined;
  }
}

/** Recompute the tier-3 key from a stored job, for cross-source dedupe checks. */
export function fingerprintOf(job: {
  normalizedCompanyName: string;
  normalizedTitle: string;
  locationText?: string | undefined;
  descriptionText: string;
}): string {
  return computeFingerprint(job);
}
