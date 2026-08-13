import type { Migration } from './001-initial.js';

/**
 * Phase 2.5: separate a logical opportunity from the postings that advertise it.
 *
 * Migration 001 stored both in `jobs`, which meant one row could hold only one
 * source identity. The same role on two ATS providers matched by fingerprint and
 * merged, after which each scan rewrote `source_job_id` and the repost detector
 * reported a repost forever. Repost cadence is the primary ghost-job signal in
 * Phase 3, so that noise had to be removed before evaluation is built on it.
 *
 * New shape:
 *   jobs            - the logical role (content, scope, lifecycle)
 *   source_postings - one row per source advertising that role (identity, URLs)
 *   job_snapshots   - immutable content revisions, now attributed to a posting
 *   evaluations     - bound to the snapshot they judged
 */
export const migration003: Migration = {
  version: 3,
  name: 'source-postings',
  sql: `
CREATE TABLE source_postings (
  id                    TEXT PRIMARY KEY,
  job_id                TEXT NOT NULL REFERENCES jobs(id),
  source_type           TEXT NOT NULL,
  source_name           TEXT,
  source_job_id         TEXT,
  source_url            TEXT NOT NULL,
  canonical_url         TEXT,
  apply_url             TEXT,
  application_system    TEXT,
  identity_key          TEXT NOT NULL UNIQUE,
  identity_tier         TEXT NOT NULL,
  location_text         TEXT,
  capture_mode          TEXT NOT NULL DEFAULT 'scoped',
  -- Hash of the body this source last advertised, even when the body itself is
  -- not retained (history mode). has_body records whether it is retained.
  description_hash      TEXT,
  has_body              INTEGER NOT NULL DEFAULT 0,
  posted_at             TEXT,
  first_seen_at         TEXT NOT NULL,
  last_seen_at          TEXT NOT NULL,
  closed_at             TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX idx_source_postings_job ON source_postings(job_id);
CREATE INDEX idx_source_postings_source ON source_postings(source_name, last_seen_at);
CREATE INDEX idx_source_postings_url ON source_postings(canonical_url);
CREATE INDEX idx_source_postings_open ON source_postings(closed_at, last_seen_at);

INSERT INTO source_postings (
  id, job_id, source_type, source_name, source_job_id, source_url, canonical_url,
  apply_url, application_system, identity_key, identity_tier, location_text,
  capture_mode, description_hash, has_body, posted_at, first_seen_at, last_seen_at,
  closed_at, created_at, updated_at
)
SELECT
  'post_' || substr(id, 5), id, source_type, source_name, source_job_id, source_url,
  canonical_url, apply_url, application_system, identity_key, identity_tier, location_text,
  capture_mode, description_hash, CASE WHEN LENGTH(description_text) > 0 THEN 1 ELSE 0 END,
  posted_at, first_seen_at, last_seen_at, closed_at, created_at, updated_at
FROM jobs;

-- Rebuild jobs without source-specific identity. SQLite has no safe multi-column
-- drop that preserves indexes, so the table is recreated and copied.
CREATE TABLE jobs_new (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES companies(id),
  title             TEXT NOT NULL,
  normalized_title  TEXT NOT NULL,
  level             TEXT,
  employment_type   TEXT NOT NULL DEFAULT 'unknown',
  work_arrangement  TEXT NOT NULL DEFAULT 'unknown',
  location_text     TEXT,
  country           TEXT,
  department        TEXT,
  team              TEXT,
  salary_min        INTEGER,
  salary_max        INTEGER,
  salary_currency   TEXT,
  salary_period     TEXT,
  -- Best known content across every posting of this role.
  description_text  TEXT NOT NULL,
  description_hash  TEXT NOT NULL,
  has_body          INTEGER NOT NULL DEFAULT 0,
  fingerprint       TEXT NOT NULL,
  -- Location-independent clustering key, set only when a body is known.
  cluster_key       TEXT,
  in_scope          INTEGER NOT NULL DEFAULT 1,
  scope_reason      TEXT,
  posted_at         TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  closed_at         TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

INSERT INTO jobs_new (
  id, company_id, title, normalized_title, level, employment_type, work_arrangement,
  location_text, country, department, team, salary_min, salary_max, salary_currency,
  salary_period, description_text, description_hash, has_body, fingerprint, cluster_key,
  in_scope, scope_reason, posted_at, first_seen_at, last_seen_at, closed_at,
  created_at, updated_at
)
SELECT
  id, company_id, title, normalized_title, level, employment_type, work_arrangement,
  location_text, country, department, team, salary_min, salary_max, salary_currency,
  salary_period, description_text, description_hash,
  CASE WHEN LENGTH(description_text) > 0 THEN 1 ELSE 0 END,
  fingerprint, NULL, in_scope, scope_reason, posted_at, first_seen_at, last_seen_at,
  closed_at, created_at, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_company_title ON jobs(company_id, normalized_title);
CREATE INDEX idx_jobs_first_seen ON jobs(first_seen_at);
CREATE INDEX idx_jobs_last_seen ON jobs(last_seen_at);
CREATE INDEX idx_jobs_fingerprint ON jobs(fingerprint);
CREATE INDEX idx_jobs_cluster ON jobs(company_id, cluster_key);
CREATE INDEX idx_jobs_in_scope ON jobs(in_scope, last_seen_at);
CREATE INDEX idx_jobs_department ON jobs(department);
CREATE INDEX idx_jobs_open ON jobs(closed_at, last_seen_at);

-- Snapshots and events belong to the posting that produced them.
ALTER TABLE job_snapshots ADD COLUMN posting_id TEXT REFERENCES source_postings(id);
UPDATE job_snapshots SET posting_id = 'post_' || substr(job_id, 5);
CREATE INDEX idx_job_snapshots_posting ON job_snapshots(posting_id, captured_at);

ALTER TABLE job_seen_events ADD COLUMN posting_id TEXT REFERENCES source_postings(id);
UPDATE job_seen_events SET posting_id = 'post_' || substr(job_id, 5);
CREATE INDEX idx_job_seen_events_posting ON job_seen_events(posting_id, seen_at);

-- An evaluation must name the exact content it judged, so a later edit can be
-- detected and the verdict marked stale instead of silently misattributed.
ALTER TABLE evaluations ADD COLUMN snapshot_id TEXT REFERENCES job_snapshots(id);
ALTER TABLE evaluations ADD COLUMN content_hash TEXT;
ALTER TABLE evaluations ADD COLUMN profile_hash TEXT;
ALTER TABLE evaluations ADD COLUMN criteria_hash TEXT;
ALTER TABLE evaluations ADD COLUMN stale_at TEXT;

CREATE INDEX idx_evaluations_cache ON evaluations(content_hash, profile_hash, criteria_hash);
`,
};
