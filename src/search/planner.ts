import type { Database } from '../db/database.js';
import type { ApplicationStatus, EvaluationDecision } from '../core/types.js';
import { funnel, segments, type SegmentDimension } from '../analytics/funnel.js';
import { search, type SearchFilters, type SearchHit } from './query.js';

/**
 * The query planner (architecture.md §20).
 *
 * `ask` classifies a question and answers it from records. It is deterministic
 * and makes no model call, which is not a limitation of this phase — it is the
 * design. "When did I apply to Zeta?" has one right answer sitting in a table;
 * sending it to a model to be paraphrased adds latency, cost, and the
 * possibility of a wrong date. §21 states the rule plainly: never produce an
 * exact date or status from memory when a structured record exists.
 *
 * SEMANTIC questions — "which roles felt most similar to that one?" — are
 * recognised and refused, because embeddings are Phase 7 and answering them
 * from keywords would be a confident, plausible, wrong answer. The refusal
 * names what would answer it instead.
 */

export type QueryKind = 'STRUCTURED' | 'KEYWORD' | 'SEMANTIC' | 'HYBRID' | 'ANALYTICS';

export interface QueryPlan {
  kind: QueryKind;
  /** Why this kind was chosen, in the user's terms. */
  because: string;
  filters: SearchFilters;
  /** For ANALYTICS: which cut of the funnel answers the question. */
  dimension: SegmentDimension | undefined;
  /** The command that reproduces this answer, so nothing is a black box. */
  equivalent: string;
}

const ANALYTICS_PATTERNS = [
  /\bhow many\b/i,
  /\bwhat (?:percentage|proportion|share|fraction)\b/i,
  /\b(?:conversion|screen|offer|response|interview)\s+rate\b/i,
  /\bfunnel\b/i,
  /\bhow often\b/i,
  /\bbreak\s?down\b/i,
];

const SEMANTIC_PATTERNS = [
  /\bsimilar to\b/i,
  /\blike the\b.*\brole\b/i,
  /\bfelt\b/i,
  /\breminds? me of\b/i,
  /\bsomething like\b/i,
  /\bkind of role\b/i,
];

const STRUCTURED_PATTERNS = [
  /\bwhen did i\b/i,
  /\bwhat did i apply\b/i,
  /\bwhich (?:roles|jobs) did i\b/i,
  /\bwhat(?:'s| is) the status\b/i,
  /\bhave i applied\b/i,
  /\bam i waiting\b/i,
];

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const STATUS_WORDS: Array<[RegExp, ApplicationStatus]> = [
  [/\brecruiter screens?\b/i, 'RECRUITER_SCREEN'],
  [/\binterview(?:s|ing|ed)?\b/i, 'INTERVIEWING'],
  [/\bfinal (?:round|stage)\b/i, 'FINAL'],
  [/\boffers?\b/i, 'OFFER'],
  [/\breject(?:ed|ion)s?\b/i, 'REJECTED'],
  [/\bwithdrew\b|\bwithdrawn\b/i, 'WITHDRAWN'],
];

const DIMENSION_WORDS: Array<[RegExp, SegmentDimension]> = [
  [/\bby company\b|\bper company\b/i, 'company'],
  [/\bby source\b/i, 'source'],
  [/\bby country\b/i, 'country'],
  [/\bby level\b|\bstaff\b|\bprincipal\b|\bsenior\b/i, 'level'],
  [/\bby department\b|\bby team\b/i, 'department'],
  [/\bremote\b|\bhybrid\b|\bonsite\b|\bon-site\b/i, 'arrangement'],
  [/\barchetype\b|\bresume strategy\b/i, 'archetype'],
  [/\bsalary\b|\bpay band\b|\bcompensation\b/i, 'salary_band'],
  [/\bby month\b|\bper month\b|\bmonthly\b/i, 'month'],
];

/** A month name, or a year, resolves to a window over the record. */
function windowFrom(question: string, now: Date): { since?: string; until?: string; label?: string } {
  const yearMatch = /\b(20\d{2})\b/.exec(question);
  const year = yearMatch?.[1] ? Number.parseInt(yearMatch[1], 10) : now.getUTCFullYear();

  const monthIndex = MONTHS.findIndex((month) => new RegExp(`\\b${month}\\b`, 'i').test(question));

  if (monthIndex >= 0) {
    const since = new Date(Date.UTC(year, monthIndex, 1));
    const until = new Date(Date.UTC(year, monthIndex + 1, 1));
    return { since: since.toISOString(), until: until.toISOString(), label: `${MONTHS[monthIndex]} ${year}` };
  }

  const relative = /\blast (\d+)?\s*(day|week|month)s?\b/i.exec(question);
  if (relative) {
    const amount = relative[1] ? Number.parseInt(relative[1], 10) : 1;
    const unit = (relative[2] ?? 'month').toLowerCase();
    const days = unit === 'day' ? amount : unit === 'week' ? amount * 7 : amount * 30;
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return { since: since.toISOString(), label: `the last ${amount} ${unit}${amount === 1 ? '' : 's'}` };
  }

  if (yearMatch) {
    return {
      since: new Date(Date.UTC(year, 0, 1)).toISOString(),
      until: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
      label: String(year),
    };
  }

  return {};
}

/**
 * Company names are matched against the ones actually stored, on word
 * boundaries.
 *
 * Guessing a company from capitalisation reads "Staff Engineer" as an employer.
 * A plain substring test has the opposite failure: "How many roles skip the
 * ramp-up period?" silently restricts the whole question to Ramp.
 */
function companyFrom(db: Database, question: string): string | undefined {
  const rows = db.prepare('SELECT name FROM companies').all() as { name: string }[];

  return rows
    .map((row) => row.name)
    .filter((name) => name.length >= 3 && mentions(question, name))
    .sort((left, right) => right.length - left.length)[0];
}

function mentions(question: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}-])`, 'iu').test(question);
}

export function planQuestion(db: Database, question: string, now = new Date()): QueryPlan {
  const window = windowFrom(question, now);
  const company = companyFrom(db, question);

  const status = STATUS_WORDS.find(([pattern]) => pattern.test(question))?.[1];

  // "Skip" has to be about the user's decision, not about the role. "Which
  // roles skip the technical screen?" is a question about hiring processes, and
  // reading it as `applied: false` returns nothing and explains nothing.
  const skipped = /\b(?:i|we)\s+(?:skipped|ignored|passed\s+on)\b|\bbut\s+skip(?:ped)?\b|\bdid\s+i\s+skip\b|\bpassed\s+on\b|\bskipped\b/i.test(
    question,
  );

  const applied = /\bapplied\b|\bapply\b/i.test(question)
    ? !/\b(?:did not|didn't|never|no)\s+(?:apply|applied)\b/i.test(question)
    : skipped
      ? false
      : undefined;

  const decision: EvaluationDecision | undefined = /\brecommend(?:ed|ation)?\b/i.test(question) ? 'APPLY' : undefined;

  const filters: SearchFilters = {
    ...(company === undefined ? {} : { company }),
    ...(status === undefined ? {} : { status }),
    ...(applied === undefined ? {} : { applied }),
    ...(decision === undefined ? {} : { decision }),
    ...(window.since === undefined ? {} : { since: window.since }),
    ...(window.until === undefined ? {} : { until: window.until }),
    includeClosed: true,
    limit: 20,
  };

  const dimension = DIMENSION_WORDS.find(([pattern]) => pattern.test(question))?.[1];

  // A constraint consumes its own words. "When did I apply to Ramp?" already
  // filters on the company; leaving "ramp" in the text query would also demand
  // the word appear in the body, and FTS requires every term.
  const words = contentWords(question, company);

  if (SEMANTIC_PATTERNS.some((pattern) => pattern.test(question))) {
    return {
      kind: 'SEMANTIC',
      because: 'this asks about resemblance, which needs embeddings (phase 7)',
      filters,
      dimension: undefined,
      equivalent: 'roleeye search "<the words you would expect to appear>"',
    };
  }

  if (ANALYTICS_PATTERNS.some((pattern) => pattern.test(question))) {
    return {
      kind: 'ANALYTICS',
      because: 'this asks for a count or a rate, which is computed from records',
      filters,
      dimension,
      equivalent: `roleeye stats --funnel${dimension ? ` --segment ${dimension}` : ''}${window.since ? ` --since ${window.since.slice(0, 10)}` : ''}`,
    };
  }

  const structural = Boolean(company || status || applied !== undefined || decision || window.since);
  const structured = STRUCTURED_PATTERNS.some((pattern) => pattern.test(question));

  if (structured && words.length === 0) {
    return {
      kind: 'STRUCTURED',
      because: 'this asks about a record, and a record answers it exactly',
      filters,
      dimension: undefined,
      equivalent: describeSearch(filters),
    };
  }

  if (structural && words.length > 0) {
    return {
      kind: 'HYBRID',
      because: 'this combines a constraint on the record with words to look for',
      filters: { ...filters, query: words.join(' ') },
      dimension: undefined,
      equivalent: describeSearch({ ...filters, query: words.join(' ') }),
    };
  }

  if (structured) {
    return {
      kind: 'STRUCTURED',
      because: 'this asks about a record, and a record answers it exactly',
      filters,
      dimension: undefined,
      equivalent: describeSearch(filters),
    };
  }

  return {
    kind: 'KEYWORD',
    because: 'no constraint was recognised, so this searches the text',
    filters: { ...filters, query: words.join(' ') },
    dimension: undefined,
    equivalent: describeSearch({ ...filters, query: words.join(' ') }),
  };
}

/**
 * The words worth searching for.
 *
 * Question words and the vocabulary of asking ("which", "did", "roles") match
 * every document and therefore rank none of them. FTS5 requires every term, so
 * leaving them in returns nothing at all.
 */
const STOP_WORDS = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'apply', 'applied', 'are', 'at', 'be', 'been', 'but', 'by',
  'can', 'did', 'do', 'does', 'for', 'from', 'get', 'got', 'had', 'has', 'have', 'how', 'i', 'in', 'is', 'it',
  'job', 'jobs', 'many', 'me', 'much', 'my', 'not', 'of', 'on', 'or', 'role', 'roles', 'saw', 'see', 'seen',
  'show', 'since', 'so', 'some', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

export function contentWords(question: string, consumed?: string | undefined): string[] {
  const taken = new Set(
    (consumed ?? '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 0),
  );

  return question
    .toLowerCase()
    .split(/[^\p{L}\p{N}_'-]+/u)
    .map((word) => word.replace(/^[-']+|[-']+$/g, ''))
    .filter(
      (word) => word.length > 2 && !STOP_WORDS.has(word) && !MONTHS.includes(word) && !taken.has(word),
    )
    .slice(0, 8);
}

function describeSearch(filters: SearchFilters): string {
  const parts = ['roleeye search'];
  if (filters.query) parts.push(`"${filters.query}"`);
  if (filters.company) parts.push(`--company "${filters.company}"`);
  if (filters.status) parts.push(`--status ${filters.status.toLowerCase()}`);
  if (filters.applied === true) parts.push('--applied');
  if (filters.applied === false) parts.push('--not-applied');
  if (filters.decision) parts.push(`--decision ${filters.decision}`);
  if (filters.since) parts.push(`--since ${filters.since.slice(0, 10)}`);
  if (filters.until) parts.push(`--until ${filters.until.slice(0, 10)}`);
  return parts.join(' ');
}

export interface AskAnswer {
  question: string;
  plan: QueryPlan;
  /** Records, never prose. The caller formats them. */
  hits: SearchHit[];
  analytics:
    | {
        counts: Record<string, number>;
        rates: Record<string, number | undefined>;
        segments: ReturnType<typeof segments> | undefined;
      }
    | undefined;
  /** Set when the question cannot be answered from what exists. */
  unanswerable: string | undefined;
}

export function ask(db: Database, question: string, now = new Date()): AskAnswer {
  const plan = planQuestion(db, question, now);

  if (plan.kind === 'SEMANTIC') {
    return {
      question,
      plan,
      hits: [],
      analytics: undefined,
      unanswerable:
        'this asks which roles resemble one another. That needs embeddings, which are not built yet ' +
        '(phase 7), and answering it from keyword overlap would be a confident guess.',
    };
  }

  if (plan.kind === 'ANALYTICS') {
    const report = funnel(db, { since: plan.filters.since, until: plan.filters.until });
    return {
      question,
      plan,
      hits: [],
      analytics: {
        counts: report.counts,
        rates: report.rates as unknown as Record<string, number | undefined>,
        segments: plan.dimension
          ? segments(db, plan.dimension, { since: plan.filters.since, until: plan.filters.until })
          : undefined,
      },
      unanswerable: undefined,
    };
  }

  const result = search(db, plan.filters);

  return {
    question,
    plan,
    hits: result.hits,
    analytics: undefined,
    unanswerable: undefined,
  };
}
