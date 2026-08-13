export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migration001: Migration = {
  version: 1,
  name: 'initial-schema',
  sql: `
CREATE TABLE companies (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  normalized_name   TEXT NOT NULL UNIQUE,
  domain            TEXT,
  careers_url       TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE jobs (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES companies(id),
  title             TEXT NOT NULL,
  normalized_title  TEXT NOT NULL,
  level             TEXT,
  employment_type   TEXT NOT NULL DEFAULT 'unknown',
  work_arrangement  TEXT NOT NULL DEFAULT 'unknown',
  location_text     TEXT,
  country           TEXT,
  salary_min        INTEGER,
  salary_max        INTEGER,
  salary_currency   TEXT,
  salary_period     TEXT,
  source_type       TEXT NOT NULL,
  source_name       TEXT,
  source_job_id     TEXT,
  source_url        TEXT NOT NULL,
  canonical_url     TEXT,
  apply_url         TEXT,
  application_system TEXT,
  identity_key      TEXT NOT NULL UNIQUE,
  identity_tier     TEXT NOT NULL,
  fingerprint       TEXT NOT NULL,
  description_text  TEXT NOT NULL,
  description_hash  TEXT NOT NULL,
  posted_at         TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  closed_at         TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_jobs_company_title ON jobs(company_id, normalized_title);
CREATE INDEX idx_jobs_first_seen ON jobs(first_seen_at);
CREATE INDEX idx_jobs_last_seen ON jobs(last_seen_at);
CREATE INDEX idx_jobs_source ON jobs(source_type, source_job_id);
CREATE INDEX idx_jobs_fingerprint ON jobs(fingerprint);
CREATE INDEX idx_jobs_canonical_url ON jobs(canonical_url);

-- Historical captures. Never overwrite the only copy of a posting.
CREATE TABLE job_snapshots (
  id                     TEXT PRIMARY KEY,
  job_id                 TEXT NOT NULL REFERENCES jobs(id),
  captured_at            TEXT NOT NULL,
  source_url             TEXT NOT NULL,
  raw_payload            TEXT,
  raw_html_path          TEXT,
  normalized_description TEXT NOT NULL,
  description_hash       TEXT NOT NULL
);

CREATE INDEX idx_job_snapshots_job ON job_snapshots(job_id, captured_at);
CREATE UNIQUE INDEX idx_job_snapshots_unique ON job_snapshots(job_id, description_hash);

CREATE TABLE job_seen_events (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES jobs(id),
  seen_at        TEXT NOT NULL,
  source_type    TEXT NOT NULL,
  source_job_id  TEXT,
  url            TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  detail         TEXT,
  scan_id        TEXT
);

CREATE INDEX idx_job_seen_events_job ON job_seen_events(job_id, seen_at);
CREATE INDEX idx_job_seen_events_type ON job_seen_events(event_type, seen_at);

CREATE TABLE scans (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  notes        TEXT
);

CREATE TABLE source_runs (
  id               TEXT PRIMARY KEY,
  scan_id          TEXT NOT NULL REFERENCES scans(id),
  source_name      TEXT NOT NULL,
  source_type      TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  status           TEXT NOT NULL,
  records_seen     INTEGER NOT NULL DEFAULT 0,
  records_new      INTEGER NOT NULL DEFAULT 0,
  records_changed  INTEGER NOT NULL DEFAULT 0,
  error            TEXT
);

CREATE INDEX idx_source_runs_scan ON source_runs(scan_id);
CREATE INDEX idx_source_runs_source ON source_runs(source_name, started_at);

-- Evaluation / application tables are created now so the schema matches the
-- documented domain model. They are populated in later phases.
CREATE TABLE evaluations (
  id                     TEXT PRIMARY KEY,
  job_id                 TEXT NOT NULL REFERENCES jobs(id),
  profile_version        TEXT,
  criteria_version       TEXT,
  created_at             TEXT NOT NULL,
  decision               TEXT NOT NULL,
  score                  INTEGER NOT NULL,
  confidence             REAL,
  headline               TEXT,
  advocate_json          TEXT,
  skeptic_json           TEXT,
  judge_json             TEXT,
  career_direction_fit   TEXT,
  career_direction_reason TEXT
);

CREATE INDEX idx_evaluations_job ON evaluations(job_id, created_at);

CREATE TABLE applications (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL REFERENCES jobs(id),
  created_at         TEXT NOT NULL,
  applied_at         TEXT,
  current_status     TEXT NOT NULL,
  resume_artifact_id TEXT,
  application_url    TEXT,
  referral           TEXT,
  source             TEXT,
  notes              TEXT
);

CREATE UNIQUE INDEX idx_applications_job ON applications(job_id);
CREATE INDEX idx_applications_applied_at ON applications(applied_at);
CREATE INDEX idx_applications_status ON applications(current_status);

CREATE TABLE application_status_events (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  notes          TEXT
);

CREATE INDEX idx_application_status_events_app ON application_status_events(application_id, occurred_at);

CREATE TABLE artifacts (
  id             TEXT PRIMARY KEY,
  job_id         TEXT REFERENCES jobs(id),
  application_id TEXT REFERENCES applications(id),
  type           TEXT NOT NULL,
  path           TEXT NOT NULL,
  checksum       TEXT,
  created_at     TEXT NOT NULL,
  metadata_json  TEXT
);

CREATE INDEX idx_artifacts_job ON artifacts(job_id, type);

CREATE TABLE notes (
  id             TEXT PRIMARY KEY,
  job_id         TEXT REFERENCES jobs(id),
  application_id TEXT REFERENCES applications(id),
  company_id     TEXT REFERENCES companies(id),
  created_at     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  text           TEXT NOT NULL,
  private        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_notes_job ON notes(job_id, created_at);
`,
};
