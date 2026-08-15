import type { Database } from '../db/database.js';
import { withTransaction } from '../db/database.js';
import { shortHash } from '../util/hash.js';
import { nowIso } from '../util/time.js';

/**
 * The search index, built from the records rather than written alongside them.
 *
 * Every document here is derived. That is a deliberate constraint: a search
 * index that is also a place things are stored eventually disagrees with the
 * database, and the database is the source of truth (agent.md). Because
 * documents are derived, dropping the whole index is always safe, and because
 * each carries the hash of what it was built from, rebuilding is incremental.
 *
 * Sync is set-based SQL, not a loop over rows. A hundred postings and a
 * thousand cost the same six statements; the work is a join the database is
 * better at than we are, and the alternative — read everything into memory,
 * hash it, write it back — is how a two-second command becomes a two-minute
 * one at the exact moment the tool becomes worth using.
 */

export const DOCUMENT_TYPES = [
  'job-description',
  'job-evaluation',
  'application-answer',
  'interview-note',
  'outcome-summary',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface IndexStats {
  documents: number;
  byType: { documentType: string; count: number }[];
  written: number;
  removed: number;
}

/**
 * Change detection, and why it differs by document type.
 *
 * A derived index is only honest if it notices every change to what it was
 * derived from. Two mechanisms are used, chosen by cost:
 *
 * - A job carries `description_hash`, already computed at ingest, so its
 *   document compares that plus `updated_at`. Re-hashing bodies of up to
 *   100 KB each on every sync would mean hashing the whole corpus to answer
 *   "has anything changed?", which is the wrong question to make expensive.
 * - Everything else — verdicts, notes, answers, outcomes — has a small body,
 *   so its document hashes the text it was built from. That is exact, and it
 *   does not depend on a promise that those tables are append-only. They are
 *   today. An index whose correctness rests on nobody adding an edit path
 *   later is an index that will quietly go stale later.
 */
const HASH_FUNCTION = 'rp_content_hash';

function registerHash(db: Database): void {
  const registered = db as Database & { [HASH_REGISTERED]?: boolean };
  if (registered[HASH_REGISTERED]) return;

  db.function(HASH_FUNCTION, { deterministic: true }, (value: unknown) => shortHash(String(value ?? ''), 20));
  registered[HASH_REGISTERED] = true;
}

const HASH_REGISTERED = Symbol.for('roleeye.searchHashRegistered');

/**
 * A job description.
 *
 * `description_text` is already normalised and capped by the ingest boundary
 * (§40), so nothing hostile is introduced here that was not already in the
 * database. Search results are printed escaped by the caller.
 */
const JOB_DOCUMENTS = `
INSERT INTO search_documents (
  id, document_type, entity_type, entity_id, job_id, company_id, created_at,
  title, company, body, metadata_json, source_hash, indexed_at
)
SELECT
  'doc_job_' || jobs.id,
  'job-description',
  'job',
  jobs.id,
  jobs.id,
  jobs.company_id,
  jobs.first_seen_at,
  jobs.title,
  companies.name,
  jobs.description_text,
  json_object(
    'level', jobs.level,
    'department', jobs.department,
    'country', jobs.country,
    'location', jobs.location_text,
    'workArrangement', jobs.work_arrangement,
    'salaryMin', jobs.salary_min,
    'salaryMax', jobs.salary_max,
    'inScope', jobs.in_scope,
    'closedAt', jobs.closed_at
  ),
  jobs.description_hash || ':' || jobs.updated_at,
  @now
FROM jobs
JOIN companies ON companies.id = jobs.company_id
WHERE NOT EXISTS (
  SELECT 1 FROM search_documents existing
  WHERE existing.id = 'doc_job_' || jobs.id
    AND existing.source_hash = jobs.description_hash || ':' || jobs.updated_at
)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  company = excluded.company,
  body = excluded.body,
  metadata_json = excluded.metadata_json,
  source_hash = excluded.source_hash,
  indexed_at = excluded.indexed_at`;

/**
 * An evaluation: the headline plus the reasoning the model produced.
 *
 * The JSON blobs are indexed as text. "Which role was the one where the
 * skeptic worried about on-call?" is a question about the reasoning, and it is
 * unanswerable if only the verdict is searchable.
 */
const EVALUATION_BODY = `
  COALESCE(evaluations.headline, '') || CHAR(10) ||
    COALESCE(evaluations.advocate_json, '') || CHAR(10) ||
    COALESCE(evaluations.skeptic_json, '') || CHAR(10) ||
    COALESCE(evaluations.judge_json, '')`;

const EVALUATION_METADATA = `
  json_object(
    'decision', evaluations.decision,
    'score', evaluations.score,
    'confidence', evaluations.confidence,
    'staleAt', evaluations.stale_at
  )`;

const EVALUATION_HASH = `${HASH_FUNCTION}(jobs.title || CHAR(31) || ${EVALUATION_BODY} || CHAR(31) || ${EVALUATION_METADATA})`;

const EVALUATION_DOCUMENTS = `
INSERT INTO search_documents (
  id, document_type, entity_type, entity_id, job_id, company_id, created_at,
  title, company, body, metadata_json, source_hash, indexed_at
)
SELECT
  'doc_eval_' || evaluations.id,
  'job-evaluation',
  'evaluation',
  evaluations.id,
  evaluations.job_id,
  jobs.company_id,
  evaluations.created_at,
  jobs.title,
  companies.name,
  ${EVALUATION_BODY},
  ${EVALUATION_METADATA},
  ${EVALUATION_HASH},
  @now
FROM evaluations
JOIN jobs ON jobs.id = evaluations.job_id
JOIN companies ON companies.id = jobs.company_id
WHERE NOT EXISTS (
  SELECT 1 FROM search_documents existing
  WHERE existing.id = 'doc_eval_' || evaluations.id
    AND existing.source_hash = ${EVALUATION_HASH}
)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  company = excluded.company,
  body = excluded.body,
  metadata_json = excluded.metadata_json,
  source_hash = excluded.source_hash,
  indexed_at = excluded.indexed_at`;

const NOTE_METADATA = `json_object('kind', notes.kind, 'private', notes.private)`;
const NOTE_HASH = `${HASH_FUNCTION}(notes.text || CHAR(31) || ${NOTE_METADATA})`;

const NOTE_DOCUMENTS = `
INSERT INTO search_documents (
  id, document_type, entity_type, entity_id, job_id, company_id, created_at,
  title, company, body, metadata_json, source_hash, indexed_at
)
SELECT
  'doc_note_' || notes.id,
  'interview-note',
  'note',
  notes.id,
  notes.job_id,
  COALESCE(notes.company_id, jobs.company_id),
  notes.created_at,
  COALESCE(jobs.title, ''),
  COALESCE(companies.name, ''),
  notes.text,
  ${NOTE_METADATA},
  ${NOTE_HASH},
  @now
FROM notes
LEFT JOIN jobs ON jobs.id = notes.job_id
LEFT JOIN companies ON companies.id = COALESCE(notes.company_id, jobs.company_id)
WHERE NOT EXISTS (
  SELECT 1 FROM search_documents existing
  WHERE existing.id = 'doc_note_' || notes.id
    AND existing.source_hash = ${NOTE_HASH}
)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  company = excluded.company,
  body = excluded.body,
  metadata_json = excluded.metadata_json,
  source_hash = excluded.source_hash,
  indexed_at = excluded.indexed_at`;

const ANSWER_METADATA = `
  json_object(
    'sensitive', application_answers.sensitive,
    'scope', application_answers.scope,
    'scopeValue', application_answers.scope_value
  )`;

const ANSWER_HASH = `${HASH_FUNCTION}(
  application_answers.question_text || CHAR(31) ||
  COALESCE(application_answers.answer, '') || CHAR(31) || ${ANSWER_METADATA}
)`;

/**
 * A stored answer.
 *
 * The answer text is indexed; the question is the title. A protected answer is
 * indexed like any other, because this index never leaves the machine and the
 * user searching their own answers is the point of storing them.
 */
const ANSWER_DOCUMENTS = `
INSERT INTO search_documents (
  id, document_type, entity_type, entity_id, job_id, company_id, created_at,
  title, company, body, metadata_json, source_hash, indexed_at
)
SELECT
  'doc_answer_' || application_answers.id,
  'application-answer',
  'answer',
  application_answers.id,
  NULL,
  NULL,
  application_answers.created_at,
  application_answers.question_text,
  '',
  COALESCE(application_answers.answer, ''),
  ${ANSWER_METADATA},
  ${ANSWER_HASH},
  @now
FROM application_answers
WHERE NOT EXISTS (
  SELECT 1 FROM search_documents existing
  WHERE existing.id = 'doc_answer_' || application_answers.id
    AND existing.source_hash = ${ANSWER_HASH}
)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  body = excluded.body,
  metadata_json = excluded.metadata_json,
  source_hash = excluded.source_hash,
  indexed_at = excluded.indexed_at`;

/**
 * What happened after applying.
 *
 * `COALESCE` around the event roll-up is not defensive noise: `group_concat`
 * over no rows returns NULL, and `body` is NOT NULL, so an application with no
 * status events would abort the whole sync.
 */
const OUTCOME_BODY = `
  COALESCE((
    SELECT group_concat(
      COALESCE(events.from_status, 'none') || ' to ' || events.to_status ||
      CASE WHEN events.notes IS NULL THEN '' ELSE ': ' || events.notes END,
      CHAR(10)
    )
    FROM application_status_events events
    WHERE events.application_id = applications.id
  ), '')`;

const OUTCOME_METADATA = `
  json_object(
    'status', applications.current_status,
    'appliedAt', applications.applied_at,
    'archetypeId', applications.archetype_id,
    'decisionAtApply', applications.decision_at_apply,
    'scoreAtApply', applications.score_at_apply
  )`;

const OUTCOME_HASH = `${HASH_FUNCTION}(${OUTCOME_BODY} || CHAR(31) || ${OUTCOME_METADATA})`;

const OUTCOME_DOCUMENTS = `
INSERT INTO search_documents (
  id, document_type, entity_type, entity_id, job_id, company_id, created_at,
  title, company, body, metadata_json, source_hash, indexed_at
)
SELECT
  'doc_app_' || applications.id,
  'outcome-summary',
  'application',
  applications.id,
  applications.job_id,
  jobs.company_id,
  applications.created_at,
  jobs.title,
  companies.name,
  ${OUTCOME_BODY},
  ${OUTCOME_METADATA},
  ${OUTCOME_HASH},
  @now
FROM applications
JOIN jobs ON jobs.id = applications.job_id
JOIN companies ON companies.id = jobs.company_id
WHERE NOT EXISTS (
  SELECT 1 FROM search_documents existing
  WHERE existing.id = 'doc_app_' || applications.id
    AND existing.source_hash = ${OUTCOME_HASH}
)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  company = excluded.company,
  body = excluded.body,
  metadata_json = excluded.metadata_json,
  source_hash = excluded.source_hash,
  indexed_at = excluded.indexed_at`;

/**
 * Documents whose record is gone.
 *
 * Job history is never deleted, so this is nearly always empty. It exists
 * because an index that can only grow is an index that eventually answers with
 * something that no longer exists, and "never produce an exact fact from
 * memory when a record exists" cuts both ways.
 */
const ORPHANS = `
DELETE FROM search_documents
WHERE (entity_type = 'job' AND entity_id NOT IN (SELECT id FROM jobs))
   OR (entity_type = 'evaluation' AND entity_id NOT IN (SELECT id FROM evaluations))
   OR (entity_type = 'note' AND entity_id NOT IN (SELECT id FROM notes))
   OR (entity_type = 'answer' AND entity_id NOT IN (SELECT id FROM application_answers))
   OR (entity_type = 'application' AND entity_id NOT IN (SELECT id FROM applications))`;

export interface SyncOptions {
  /** Drops every document first. Used by `--reindex`. */
  rebuild?: boolean;
}

export function syncSearchIndex(db: Database, options: SyncOptions = {}): IndexStats {
  const now = nowIso();
  registerHash(db);

  return withTransaction(db, () => {
    if (options.rebuild) {
      db.exec('DELETE FROM search_documents');
    }

    let written = 0;
    for (const statement of [
      JOB_DOCUMENTS,
      EVALUATION_DOCUMENTS,
      NOTE_DOCUMENTS,
      ANSWER_DOCUMENTS,
      OUTCOME_DOCUMENTS,
    ]) {
      written += db.prepare(statement).run({ now }).changes;
    }

    const removed = db.prepare(ORPHANS).run().changes;

    // FTS5 keeps its own copy of the term index; after a large rebuild it is
    // worth telling it to merge, and it is cheap when there is nothing to do.
    if (options.rebuild) db.prepare(`INSERT INTO search_fts(search_fts) VALUES ('optimize')`).run();

    return { ...indexStats(db), written, removed };
  });
}

export function indexStats(db: Database): IndexStats {
  const total = db.prepare('SELECT COUNT(*) AS n FROM search_documents').get() as { n: number };
  const byType = db
    .prepare('SELECT document_type, COUNT(*) AS n FROM search_documents GROUP BY document_type ORDER BY document_type')
    .all() as { document_type: string; n: number }[];

  return {
    documents: total.n,
    byType: byType.map((row) => ({ documentType: row.document_type, count: row.n })),
    written: 0,
    removed: 0,
  };
}
