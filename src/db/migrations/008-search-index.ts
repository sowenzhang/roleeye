import type { Migration } from './001-initial.js';

/**
 * Phase 6: search over what the system already knows.
 *
 * Two tables, and the split between them is the point. `search_documents` is an
 * ordinary table holding *logical documents* (architecture.md §19) — a job
 * description, an evaluation, an answer, a note — each with the entity it
 * belongs to and a hash of the text it was built from. `search_fts` is an
 * FTS5 index over it, external-content, so the descriptions are stored once
 * rather than twice. A corpus of a few thousand postings at up to 100 KB each
 * is not something to keep two copies of for the sake of a simpler trigger.
 *
 * Documents are derived, never authored: every row can be rebuilt from the
 * records, and `source_hash` is what makes rebuilding incremental. Nothing in
 * here is a source of truth, so `roleeye search --reindex` dropping the lot and
 * starting again is always safe.
 *
 * No new state is recorded for analytics. The funnel is computed from
 * `jobs`, `screenings`, `evaluations`, `applications` and
 * `application_status_events`, which is the whole reason those tables record
 * history rather than a current state — a metric derived from a stored count
 * cannot be checked against the events that produced it.
 */
export const migration008: Migration = {
  version: 8,
  name: 'search-index',
  sql: `
CREATE TABLE search_documents (
  id            TEXT PRIMARY KEY,
  -- job-description | job-evaluation | application-answer | interview-note |
  -- company-note | outcome-summary
  document_type TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  job_id        TEXT REFERENCES jobs(id),
  company_id    TEXT REFERENCES companies(id),
  created_at    TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  company       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  -- Hash of the record this document was built from. Rebuilds skip anything
  -- unchanged, so re-indexing a large corpus costs a few statements.
  source_hash   TEXT NOT NULL,
  indexed_at    TEXT NOT NULL
);

CREATE INDEX idx_search_documents_job ON search_documents(job_id);
CREATE INDEX idx_search_documents_type ON search_documents(document_type, created_at);
CREATE INDEX idx_search_documents_entity ON search_documents(entity_type, entity_id);

CREATE VIRTUAL TABLE search_fts USING fts5(
  title,
  company,
  body,
  content = 'search_documents',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- External-content FTS5 keeps no copy of the text, so it has to be told about
-- every change. These three triggers are the entire contract.
CREATE TRIGGER search_documents_ai AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_fts(rowid, title, company, body)
  VALUES (new.rowid, new.title, new.company, new.body);
END;

CREATE TRIGGER search_documents_ad AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, company, body)
  VALUES ('delete', old.rowid, old.title, old.company, old.body);
END;

CREATE TRIGGER search_documents_au AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, company, body)
  VALUES ('delete', old.rowid, old.title, old.company, old.body);
  INSERT INTO search_fts(rowid, title, company, body)
  VALUES (new.rowid, new.title, new.company, new.body);
END;
`,
};
