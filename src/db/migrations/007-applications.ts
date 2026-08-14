import type { Migration } from './001-initial.js';

/**
 * Phase 5: applications, their history, and the answers that travel with them.
 *
 * `applications` is rebuilt rather than extended. It shipped in migration 001
 * for a phase that had not been designed — the third table in this codebase to
 * do that, after `evaluations` and `artifacts` — and it shows: a free-text
 * `notes` column duplicating the `notes` table, and no way to record which
 * resume was actually sent. It has never held a row, so this is free.
 */
export const migration007: Migration = {
  version: 7,
  name: 'applications-and-answers',
  sql: `
CREATE TABLE applications_new (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL REFERENCES jobs(id),
  created_at         TEXT NOT NULL,
  applied_at         TEXT,
  current_status     TEXT NOT NULL,
  -- Which resume actually went out. Without this a reply six weeks later
  -- cannot be attributed to the document that earned it, which is the whole
  -- point of keeping generations.
  archetype_id       TEXT,
  generation_id      TEXT REFERENCES resume_generations(id),
  resume_artifact_id TEXT REFERENCES artifacts(id),
  application_url    TEXT,
  referral           TEXT,
  source             TEXT,
  -- What the system thought at the moment of applying, so a later outcome can
  -- be compared against the advice rather than against today's re-scoring.
  evaluation_id      TEXT REFERENCES evaluations(id),
  decision_at_apply  TEXT,
  score_at_apply     REAL,
  closed_at          TEXT
);

INSERT INTO applications_new (id, job_id, created_at, applied_at, current_status, resume_artifact_id, application_url, referral, source)
SELECT id, job_id, created_at, applied_at, current_status, resume_artifact_id, application_url, referral, source FROM applications;

DROP TABLE applications;
ALTER TABLE applications_new RENAME TO applications;

CREATE UNIQUE INDEX idx_applications_job ON applications(job_id);
CREATE INDEX idx_applications_applied_at ON applications(applied_at);
CREATE INDEX idx_applications_status ON applications(current_status);

-- Status history is append-only (architecture.md §17). The row above caches
-- the latest state; this table is what actually happened.
ALTER TABLE application_status_events ADD COLUMN source TEXT NOT NULL DEFAULT 'user';

-- Where the user disagreed with the recommendation.
--
-- Recorded from this phase even though the learning loop is phase 8, because a
-- loop built later can only learn from data collected earlier (progress.md,
-- 2026-08-13). Both directions matter: applying to a role that was screened
-- out says as much as ignoring one that scored well.
CREATE TABLE role_feedback (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  evaluation_id TEXT REFERENCES evaluations(id),
  kind          TEXT NOT NULL,
  decision      TEXT,
  score         REAL,
  reason        TEXT,
  created_at    TEXT NOT NULL,
  CHECK (kind IN ('applied_despite_advice', 'skipped_despite_advice', 'agreed', 'corrected'))
);

CREATE INDEX idx_role_feedback_job ON role_feedback(job_id, created_at);
CREATE INDEX idx_role_feedback_kind ON role_feedback(kind, created_at);

-- The application question bank (docs/vision.md §8).
--
-- Provenance, permitted transformation, sensitivity, scope and freshness are
-- independent axes, not one category. An earlier draft sorted answers into
-- "recalled / composed / never invented" and it did not survive contact with
-- real forms: a work-authorisation answer is recalled *and* protected, and
-- compensation appeared under two headings at once.
CREATE TABLE application_answers (
  id             TEXT PRIMARY KEY,
  question_key   TEXT NOT NULL,
  question_text  TEXT NOT NULL,
  answer         TEXT,
  -- user_stated | system_derived | model_drafted
  provenance     TEXT NOT NULL DEFAULT 'user_stated',
  -- exact | formatting | calculated | drafted
  transformation TEXT NOT NULL DEFAULT 'exact',
  -- Protected categories are never invented and never reused from a
  -- similar-looking previous answer.
  sensitive      INTEGER NOT NULL DEFAULT 0,
  -- universal, or narrowed to an employer, a jurisdiction, or a role.
  scope          TEXT NOT NULL DEFAULT 'universal',
  scope_value    TEXT,
  fact_ids_json  TEXT NOT NULL DEFAULT '[]',
  confirmed_at   TEXT,
  expires_at     TEXT,
  requires_confirmation INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (provenance IN ('user_stated', 'system_derived', 'model_drafted')),
  CHECK (transformation IN ('exact', 'formatting', 'calculated', 'drafted')),
  CHECK (scope IN ('universal', 'employer', 'jurisdiction', 'role'))
);

CREATE UNIQUE INDEX idx_application_answers_key
  ON application_answers(question_key, scope, COALESCE(scope_value, ''));
CREATE INDEX idx_application_answers_sensitive ON application_answers(sensitive);

-- Which answer was used where, and whether a human re-affirmed it there.
CREATE TABLE application_answer_uses (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  answer_id      TEXT REFERENCES application_answers(id),
  question_text  TEXT NOT NULL,
  used_answer    TEXT,
  confirmed      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_application_answer_uses_app ON application_answer_uses(application_id);
`,
};
