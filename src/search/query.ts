import type { Database } from '../db/database.js';
import type { ApplicationStatus, EvaluationDecision } from '../core/types.js';
import { syncSearchIndex, type DocumentType } from './indexer.js';

/**
 * Search, in the two stages architecture.md §18 asks for and no more.
 *
 * Stage 1 is SQL over the records: dates, company, decision, application
 * status, salary, source, country. Stage 2 is FTS5 over the derived documents.
 * Stage 3, embeddings, is deliberately absent — it is only worth building once
 * there is history for it to beat structured search on, and until then it would
 * be a slower, vaguer answer to questions SQL answers exactly.
 *
 * The two stages compose rather than compete: a free-text query narrows by
 * relevance, and every structured filter still applies to the result. "AI
 * platform roles I saw in July but did not apply to" is one query, not two.
 */

export interface SearchFilters {
  /** Free text. Empty means a purely structured search. */
  query?: string | undefined;
  documentTypes?: DocumentType[] | undefined;
  company?: string | undefined;
  title?: string | undefined;
  decision?: EvaluationDecision | undefined;
  status?: ApplicationStatus | undefined;
  applied?: boolean | undefined;
  source?: string | undefined;
  country?: string | undefined;
  minSalary?: number | undefined;
  since?: string | undefined;
  until?: string | undefined;
  includeClosed?: boolean | undefined;
  limit?: number | undefined;
}

export interface SearchHit {
  documentId: string;
  documentType: string;
  jobId: string | undefined;
  title: string;
  company: string;
  createdAt: string;
  /** FTS relevance, absent for a purely structured search. */
  rank: number | undefined;
  /** The matching words in context, from FTS5's own snippet function. */
  excerpt: string | undefined;
  decision: EvaluationDecision | undefined;
  score: number | undefined;
  status: ApplicationStatus | undefined;
  appliedAt: string | undefined;
  firstSeenAt: string | undefined;
  country: string | undefined;
  salaryMin: number | undefined;
}

interface HitRow {
  document_id: string;
  document_type: string;
  job_id: string | null;
  title: string;
  company: string;
  created_at: string;
  rank: number | null;
  excerpt: string | null;
  decision: string | null;
  score: number | null;
  status: string | null;
  applied_at: string | null;
  first_seen_at: string | null;
  country: string | null;
  salary_min: number | null;
}

/**
 * Turns user words into an FTS5 MATCH expression.
 *
 * FTS5's query language is a language: `AND`, `NEAR`, `*`, `"`, `:` and `^` all
 * mean something, and a stray quote is a syntax error rather than a search for
 * a quote. A person typing `senior "staff" engineer (remote)` means to search
 * for those words, so every term is quoted as a literal phrase and the operators
 * are never reachable from input. A search box that can raise a syntax error is
 * a search box people stop using.
 */
export function toMatchExpression(query: string): string | undefined {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_'-]+/u)
    .map((term) => term.replace(/^[-']+|[-']+$/g, ''))
    .filter((term) => term.length > 0)
    .slice(0, 16);

  if (terms.length === 0) return undefined;

  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ');
}

const BASE_COLUMNS = `
  documents.id            AS document_id,
  documents.document_type AS document_type,
  documents.job_id        AS job_id,
  documents.title         AS title,
  documents.company       AS company,
  documents.created_at    AS created_at,
  evaluation.decision     AS decision,
  evaluation.score        AS score,
  application.current_status AS status,
  application.applied_at  AS applied_at,
  jobs.first_seen_at      AS first_seen_at,
  jobs.country            AS country,
  jobs.salary_min         AS salary_min`;

/**
 * The latest evaluation per job, not every evaluation.
 *
 * A role evaluated three times has three verdicts, and joining them all would
 * report it three times with the oldest advice attached to a current listing.
 */
const JOINS = `
FROM search_documents documents
LEFT JOIN jobs ON jobs.id = documents.job_id
LEFT JOIN applications application ON application.job_id = documents.job_id
LEFT JOIN evaluations evaluation ON evaluation.id = (
  SELECT inner_eval.id FROM evaluations inner_eval
  WHERE inner_eval.job_id = documents.job_id
  ORDER BY inner_eval.created_at DESC, inner_eval.rowid DESC
  LIMIT 1
)`;

interface BuiltQuery {
  sql: string;
  params: Record<string, unknown>;
}

function buildQuery(filters: SearchFilters): BuiltQuery {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  const match = filters.query ? toMatchExpression(filters.query) : undefined;

  if (filters.documentTypes && filters.documentTypes.length > 0) {
    const names = filters.documentTypes.map((type, index) => {
      params[`type${index}`] = type;
      return `@type${index}`;
    });
    conditions.push(`documents.document_type IN (${names.join(', ')})`);
  }

  if (filters.company) {
    conditions.push('LOWER(documents.company) LIKE @company');
    params['company'] = `%${filters.company.toLowerCase()}%`;
  }

  if (filters.title) {
    conditions.push('LOWER(documents.title) LIKE @title');
    params['title'] = `%${filters.title.toLowerCase()}%`;
  }

  if (filters.decision) {
    conditions.push('evaluation.decision = @decision');
    params['decision'] = filters.decision;
  }

  if (filters.status) {
    conditions.push('application.current_status = @status');
    params['status'] = filters.status;
  }

  if (filters.applied === true) conditions.push('application.id IS NOT NULL');
  if (filters.applied === false) conditions.push('application.id IS NULL');

  if (filters.source) {
    conditions.push(
      `EXISTS (SELECT 1 FROM source_postings posting
               WHERE posting.job_id = documents.job_id
                 AND (posting.source_type = @source OR posting.source_name = @source))`,
    );
    params['source'] = filters.source;
  }

  if (filters.country) {
    conditions.push('UPPER(jobs.country) = UPPER(@country)');
    params['country'] = filters.country;
  }

  if (filters.minSalary !== undefined) {
    // A stated maximum above the floor counts: a range of 180k-220k satisfies a
    // 200k floor, and rejecting it would hide the roles most worth seeing.
    conditions.push('(jobs.salary_max >= @minSalary OR jobs.salary_min >= @minSalary)');
    params['minSalary'] = filters.minSalary;
  }

  if (filters.since) {
    conditions.push('documents.created_at >= @since');
    params['since'] = filters.since;
  }

  if (filters.until) {
    conditions.push('documents.created_at <= @until');
    params['until'] = filters.until;
  }

  if (!filters.includeClosed) {
    conditions.push('(documents.job_id IS NULL OR jobs.closed_at IS NULL)');
  }

  params['limit'] = Math.min(Math.max(filters.limit ?? 25, 1), 200);

  if (match) {
    params['match'] = match;
    return {
      sql: `
SELECT ${BASE_COLUMNS},
  search_fts.rank AS rank,
  snippet(search_fts, 2, '[', ']', ' … ', 12) AS excerpt
${JOINS}
JOIN search_fts ON search_fts.rowid = documents.rowid
WHERE search_fts MATCH @match
  ${conditions.length > 0 ? `AND ${conditions.join('\n  AND ')}` : ''}
ORDER BY search_fts.rank
LIMIT @limit`,
      params,
    };
  }

  return {
    sql: `
SELECT ${BASE_COLUMNS},
  NULL AS rank,
  NULL AS excerpt
${JOINS}
${conditions.length > 0 ? `WHERE ${conditions.join('\n  AND ')}` : ''}
ORDER BY documents.created_at DESC
LIMIT @limit`,
    params,
  };
}

function mapHit(row: HitRow): SearchHit {
  return {
    documentId: row.document_id,
    documentType: row.document_type,
    jobId: row.job_id ?? undefined,
    title: row.title,
    company: row.company,
    createdAt: row.created_at,
    rank: row.rank ?? undefined,
    excerpt: row.excerpt ?? undefined,
    decision: (row.decision as EvaluationDecision | null) ?? undefined,
    score: row.score ?? undefined,
    status: (row.status as ApplicationStatus | null) ?? undefined,
    appliedAt: row.applied_at ?? undefined,
    firstSeenAt: row.first_seen_at ?? undefined,
    country: row.country ?? undefined,
    salaryMin: row.salary_min ?? undefined,
  };
}

export interface SearchResult {
  hits: SearchHit[];
  /** The FTS expression actually used, so a surprising result is explainable. */
  matchExpression: string | undefined;
  indexed: number;
}

export interface SearchOptions {
  /** Skips the index refresh. Used when the caller has just synced. */
  skipSync?: boolean;
}

export function search(db: Database, filters: SearchFilters, options: SearchOptions = {}): SearchResult {
  const stats = options.skipSync ? undefined : syncSearchIndex(db);
  const { sql, params } = buildQuery(filters);
  const rows = db.prepare(sql).all(params) as HitRow[];

  return {
    hits: rows.map(mapHit),
    matchExpression: filters.query ? toMatchExpression(filters.query) : undefined,
    indexed: stats?.documents ?? 0,
  };
}
