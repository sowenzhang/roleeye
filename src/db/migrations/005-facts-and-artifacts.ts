import type { Migration } from './001-initial.js';

/**
 * Phase 4: the fact store, archetype assignments, and generated artifacts.
 *
 * Facts live here rather than in `profile/accomplishments.yaml` because
 * approval is lifecycle state (architecture.md §15). A YAML file cannot record
 * that a statement was reviewed by a human, when, and from which document it
 * came — and editing an approved statement in a text editor would silently
 * re-approve text nobody read.
 *
 * `artifacts` is rebuilt rather than extended. It shipped in migration 001 for
 * a phase that had not been designed, naming a job and nothing else, so a
 * generated resume could not be attributed to the facts, archetype, or profile
 * that produced it. That is the same defect migration 003 had to correct in
 * `evaluations`.
 */
export const migration005: Migration = {
  version: 5,
  name: 'facts-and-artifacts',
  sql: `
-- One employment block. The unit of approval: approving 60 atomic facts is a
-- form nobody fills in honestly, so the user approves an experience at a time.
CREATE TABLE experiences (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  company      TEXT NOT NULL,
  role         TEXT NOT NULL,
  started_on   TEXT,
  ended_on     TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- One document import. Kept so an imported fact can always name the file and
-- the exact bytes it came from, and so a re-import of the same file is
-- recognisable as the same import rather than a new set of duplicates.
CREATE TABLE fact_imports (
  id                TEXT PRIMARY KEY,
  source_path       TEXT NOT NULL,
  source_sha256     TEXT NOT NULL,
  format            TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  extractor         TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  facts_created     INTEGER NOT NULL DEFAULT 0,
  facts_updated     INTEGER NOT NULL DEFAULT 0,
  facts_unchanged   INTEGER NOT NULL DEFAULT 0,
  warnings_json     TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_fact_imports_sha ON fact_imports(source_sha256);

-- A claim about the user, in the user's own words.
--
-- statement_hash is what approval is bound to: if the statement changes, the
-- row returns to draft, because the approval was of the old words.
CREATE TABLE facts (
  id             TEXT PRIMARY KEY,
  experience_id  TEXT REFERENCES experiences(id),
  statement      TEXT NOT NULL,
  statement_hash TEXT NOT NULL,
  tags_json      TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'draft',
  approved_at    TEXT,
  import_id      TEXT REFERENCES fact_imports(id),
  origin         TEXT NOT NULL DEFAULT 'import',
  retired_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (status IN ('draft', 'approved')),
  CHECK (status = 'draft' OR approved_at IS NOT NULL)
);

CREATE UNIQUE INDEX idx_facts_statement ON facts(statement_hash);
CREATE INDEX idx_facts_experience ON facts(experience_id, status);
CREATE INDEX idx_facts_status ON facts(status, retired_at);

-- Which archetype a posting belongs to.
--
-- Archetypes themselves are configuration (config/archetypes.yaml) with a
-- content-derived hash, exactly as criteria are. Only the assignment is state,
-- and it records how it was made: an assignment the user made by hand must
-- never be silently overwritten by the classifier.
CREATE TABLE archetype_assignments (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES jobs(id),
  archetype_id   TEXT,
  archetype_hash TEXT NOT NULL,
  score          REAL NOT NULL DEFAULT 0,
  runner_up_id   TEXT,
  runner_up_score REAL,
  method         TEXT NOT NULL DEFAULT 'deterministic',
  evidence_json  TEXT NOT NULL DEFAULT '[]',
  assigned_at    TEXT NOT NULL,
  CHECK (method IN ('deterministic', 'manual', 'model'))
);

CREATE UNIQUE INDEX idx_archetype_assignments_job ON archetype_assignments(job_id, archetype_hash);
CREATE INDEX idx_archetype_assignments_archetype ON archetype_assignments(archetype_id);

-- One generated resume for one archetype.
--
-- The hashes are what make staleness detectable: change the approved fact set,
-- the archetype definition, or the profile, and the stored generation no longer
-- matches its inputs.
CREATE TABLE resume_generations (
  id             TEXT PRIMARY KEY,
  archetype_id   TEXT NOT NULL,
  archetype_hash TEXT NOT NULL,
  fact_set_hash  TEXT NOT NULL,
  profile_hash   TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  headline       TEXT,
  summary        TEXT,
  document_json  TEXT NOT NULL,
  validated      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  superseded_at  TEXT
);

CREATE INDEX idx_resume_generations_archetype ON resume_generations(archetype_id, created_at);

-- Every generated sentence, with the facts it claims to rest on.
--
-- This is what makes "no unsupported claim can pass validation" checkable after
-- the fact rather than only at generation time.
CREATE TABLE resume_claims (
  id            TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES resume_generations(id),
  section       TEXT NOT NULL,
  position      INTEGER NOT NULL,
  text          TEXT NOT NULL,
  fact_ids_json TEXT NOT NULL DEFAULT '[]',
  supported     INTEGER NOT NULL DEFAULT 0,
  problems_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_resume_claims_generation ON resume_claims(generation_id, section, position);

-- Rebuild of artifacts. The old table is copied forward, so any path already
-- recorded survives; the new columns are simply unknown for those rows.
CREATE TABLE artifacts_new (
  id             TEXT PRIMARY KEY,
  job_id         TEXT REFERENCES jobs(id),
  application_id TEXT REFERENCES applications(id),
  generation_id  TEXT REFERENCES resume_generations(id),
  archetype_id   TEXT,
  snapshot_id    TEXT REFERENCES job_snapshots(id),
  type           TEXT NOT NULL,
  path           TEXT NOT NULL,
  checksum       TEXT,
  content_hash   TEXT,
  created_at     TEXT NOT NULL,
  superseded_at  TEXT,
  metadata_json  TEXT
);

INSERT INTO artifacts_new (id, job_id, application_id, type, path, checksum, created_at, metadata_json)
SELECT id, job_id, application_id, type, path, checksum, created_at, metadata_json FROM artifacts;

DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;

CREATE INDEX idx_artifacts_job ON artifacts(job_id, type);
CREATE INDEX idx_artifacts_generation ON artifacts(generation_id);
CREATE UNIQUE INDEX idx_artifacts_path ON artifacts(path);
`,
};
