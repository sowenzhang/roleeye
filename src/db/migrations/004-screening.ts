import type { Migration } from './001-initial.js';

/**
 * Phase 3a: deterministic screening results and spend accounting.
 *
 * Screenings are versioned by criteria hash rather than overwritten, so a later
 * change to the user's rules does not rewrite the history of what was decided
 * and why.
 */
export const migration004: Migration = {
  version: 4,
  name: 'screening-and-spend',
  sql: `
-- Content alone, with no company or location in it. The existing fingerprint
-- and cluster_key both include the company, so neither can answer "is this same
-- description being advertised by unrelated companies?" — the content-farm
-- signal that only a system retaining history can see.
ALTER TABLE jobs ADD COLUMN content_key TEXT;
CREATE INDEX idx_jobs_content_key ON jobs(content_key);

CREATE TABLE job_screenings (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL REFERENCES jobs(id),
  screened_at        TEXT NOT NULL,
  criteria_hash      TEXT NOT NULL,
  -- Eligibility from deterministic hard filters only.
  eligible           INTEGER NOT NULL,
  rejections_json    TEXT NOT NULL DEFAULT '[]',
  warnings_json      TEXT NOT NULL DEFAULT '[]',
  -- Authenticity as independent dimensions; a posting can be several at once.
  freshness          TEXT NOT NULL DEFAULT 'unknown',
  hiring_intent      TEXT NOT NULL DEFAULT 'unknown',
  fraud_risk         TEXT NOT NULL DEFAULT 'low',
  provenance         TEXT NOT NULL DEFAULT 'unverified',
  signals_json       TEXT NOT NULL DEFAULT '[]',
  blocked            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_job_screenings_job ON job_screenings(job_id, screened_at);
CREATE INDEX idx_job_screenings_eligible ON job_screenings(eligible, screened_at);
CREATE UNIQUE INDEX idx_job_screenings_current ON job_screenings(job_id, criteria_hash);

-- Populated from phase 3b. Created now so accounting is never bolted on after
-- the first spend has already happened.
CREATE TABLE llm_calls (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT REFERENCES jobs(id),
  evaluation_id      TEXT REFERENCES evaluations(id),
  stage              TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  estimated_cost_usd REAL,
  request_count      INTEGER NOT NULL DEFAULT 1,
  cache_hit          INTEGER NOT NULL DEFAULT 0,
  succeeded          INTEGER NOT NULL DEFAULT 1,
  error              TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_llm_calls_created ON llm_calls(created_at);
CREATE INDEX idx_llm_calls_stage ON llm_calls(stage, created_at);
`,
};
