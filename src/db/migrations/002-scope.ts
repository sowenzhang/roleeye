import type { Migration } from './001-initial.js';

/**
 * Phase 2: scope and capture modes.
 *
 * `in_scope` is a cache of the scope decision at ingest time, refreshed on every
 * scan. Scope changes must never delete history, so out-of-scope rows captured
 * earlier remain queryable — they are simply not evaluated.
 */
export const migration002: Migration = {
  version: 2,
  name: 'scope-and-capture-modes',
  sql: `
ALTER TABLE jobs ADD COLUMN department TEXT;
ALTER TABLE jobs ADD COLUMN team TEXT;
ALTER TABLE jobs ADD COLUMN capture_mode TEXT NOT NULL DEFAULT 'scoped';
ALTER TABLE jobs ADD COLUMN in_scope INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN scope_reason TEXT;

CREATE INDEX idx_jobs_in_scope ON jobs(in_scope, last_seen_at);
CREATE INDEX idx_jobs_department ON jobs(department);

ALTER TABLE source_runs ADD COLUMN records_out_of_scope INTEGER NOT NULL DEFAULT 0;
`,
};
