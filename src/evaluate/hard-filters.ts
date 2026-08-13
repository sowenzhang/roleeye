import type { CriteriaConfig } from '../config/schema.js';
import type { UnknownPolicy } from '../config/screening-schema.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import type { SourcePosting } from '../db/repositories/source-postings.js';
import { requiresRelocation } from '../normalize/location.js';
import { toAnnual } from '../normalize/salary.js';
import { deniedApplicationSystems } from './criteria.js';

/**
 * Stage A of the evaluation pipeline: deterministic filters.
 *
 * Everything here is free and reproducible. A role rejected at this stage never
 * reaches a model, which is the single largest lever on cost, and the user is
 * always told which specific rule rejected it.
 */

export type FilterOutcome = 'pass' | 'reject' | 'unknown';

export interface FilterResult {
  rule: string;
  outcome: FilterOutcome;
  /** Human-readable explanation, shown verbatim by `roleeye verify`. */
  detail: string;
}

export interface HardFilterVerdict {
  eligible: boolean;
  rejections: FilterResult[];
  warnings: FilterResult[];
  results: FilterResult[];
}

export interface FilterInput {
  job: JobRecord;
  postings: SourcePosting[];
}

function pass(rule: string, detail: string): FilterResult {
  return { rule, outcome: 'pass', detail };
}

function reject(rule: string, detail: string): FilterResult {
  return { rule, outcome: 'reject', detail };
}

function unknown(rule: string, detail: string): FilterResult {
  return { rule, outcome: 'unknown', detail };
}

/** Applies the configured policy for a fact the posting never stated. */
function applyUnknownPolicy(result: FilterResult, policy: UnknownPolicy): FilterResult {
  if (policy === 'reject') return { ...result, outcome: 'reject' };
  if (policy === 'allow') return { ...result, outcome: 'pass' };
  return result;
}

function checkCountry(input: FilterInput, criteria: CriteriaConfig): FilterResult[] {
  const filters = criteria.hard_filters;
  const wanted = filters.countries.map((entry) => entry.toUpperCase());
  if (wanted.length === 0 && !filters.require_us_payroll) return [];

  const required = filters.require_us_payroll ? [...new Set([...wanted, 'US'])] : wanted;
  const country = input.job.country;

  if (!country) {
    // A remote role with no stated country is common and usually fine.
    if (input.job.workArrangement === 'remote') {
      return [pass('country', 'remote role with no stated country')];
    }
    return [
      applyUnknownPolicy(
        unknown('country', `no country stated; wanted ${required.join(', ')}`),
        filters.on_unknown.country,
      ),
    ];
  }

  return required.includes(country.toUpperCase())
    ? [pass('country', `${country} is in the allowed list`)]
    : [reject('country', `${country} is not in ${required.join(', ')}`)];
}

function checkRelocation(input: FilterInput, criteria: CriteriaConfig): FilterResult[] {
  if (!criteria.hard_filters.relocation.reject_if_required) return [];
  if (!input.job.hasBody) return [];

  return requiresRelocation(input.job.descriptionText)
    ? [reject('relocation', 'the posting states relocation is required')]
    : [pass('relocation', 'no relocation requirement found')];
}

function checkSalary(input: FilterInput, criteria: CriteriaConfig): FilterResult[] {
  const minimum = criteria.hard_filters.minimum_base_salary;
  if (!minimum) return [];

  const { job } = input;
  if (job.salaryMax === undefined && job.salaryMin === undefined) {
    return [
      applyUnknownPolicy(
        unknown('salary', `no compensation stated; minimum is ${minimum.currency} ${minimum.amount.toLocaleString('en-US')}`),
        criteria.hard_filters.on_unknown.salary,
      ),
    ];
  }

  const currency = job.salaryCurrency ?? 'USD';
  if (currency.toUpperCase() !== minimum.currency.toUpperCase()) {
    // Converting currencies would need a rate source and a date; guessing here
    // would reject real roles on a stale number.
    return [
      applyUnknownPolicy(
        unknown('salary', `stated in ${currency}, threshold in ${minimum.currency}; not comparable`),
        criteria.hard_filters.on_unknown.salary,
      ),
    ];
  }

  // The top of the range is what the role can pay, so that is what is compared.
  const best = toAnnual(job.salaryMax ?? job.salaryMin ?? 0, job.salaryPeriod);
  const formatted = `${currency} ${best.toLocaleString('en-US')}`;

  return best >= minimum.amount
    ? [pass('salary', `${formatted} meets the ${minimum.amount.toLocaleString('en-US')} minimum`)]
    : [reject('salary', `${formatted} is below the ${minimum.amount.toLocaleString('en-US')} minimum`)];
}

function checkApplicationSystem(input: FilterInput, criteria: CriteriaConfig): FilterResult[] {
  const denied = deniedApplicationSystems(criteria);
  if (denied.length === 0) return [];

  const systems = input.postings
    .map((posting) => posting.applicationSystem?.toLowerCase())
    .filter((system): system is string => Boolean(system));

  if (systems.length === 0) {
    return [unknown('application_system', 'the application system could not be identified')];
  }

  // Denied only when every route to apply is denied; one acceptable path is enough.
  const acceptable = systems.filter((system) => !denied.includes(system));
  if (acceptable.length > 0) {
    return [pass('application_system', `can apply through ${[...new Set(acceptable)].join(', ')}`)];
  }

  return [reject('application_system', `only available through ${[...new Set(systems)].join(', ')}`)];
}

/**
 * Runs every configured hard filter.
 *
 * A rejection is a statement about the user's stated rules, not a judgement
 * about the role, so each one names the rule and the value that failed it.
 */
export function applyHardFilters(input: FilterInput, criteria: CriteriaConfig): HardFilterVerdict {
  const results = [
    ...checkCountry(input, criteria),
    ...checkRelocation(input, criteria),
    ...checkSalary(input, criteria),
    ...checkApplicationSystem(input, criteria),
  ];

  const rejections = results.filter((result) => result.outcome === 'reject');
  const warnings = results.filter((result) => result.outcome === 'unknown');

  return { eligible: rejections.length === 0, rejections, warnings, results };
}
