import type { Migration } from './001-initial.js';

/**
 * Phase 4 follow-ups: fact identity, and a lifecycle for manual assignments.
 *
 * Both were found by a model review of Phase 4 and deliberately deferred rather
 * than rushed into the release. Doing them now, before Phase 5 adds its own
 * tables, is cheaper than doing them after.
 */
export const migration006: Migration = {
  version: 6,
  name: 'fact-identity-and-assignment-lifecycle',
  sql: `
-- Fact identity is scoped to the employer.
--
-- The statement hash alone was globally unique, so the same true sentence under
-- two employers — "Led a cross-functional platform migration." is exactly the
-- kind of thing that repeats — collapsed into one row and the second job lost
-- its provenance. A resume then cited one employer for work done at both.
--
-- COALESCE, because SQLite treats NULLs in a unique index as distinct, which
-- would let unattached duplicates back in through the same door.
DROP INDEX idx_facts_statement;
CREATE UNIQUE INDEX idx_facts_statement ON facts(statement_hash, COALESCE(experience_id, ''));

-- Manual assignments need to be retirable.
--
-- The manual lookup searched every archetype hash, so a correction made months
-- ago outranked a deliberate reclassification: a forced run reassigned the role,
-- and the next ordinary run copied the old manual answer back over it. The
-- row is superseded rather than deleted, because what the user said is
-- history, not noise.
ALTER TABLE archetype_assignments ADD COLUMN superseded_at TEXT;

CREATE INDEX idx_archetype_assignments_active
  ON archetype_assignments(job_id, method, superseded_at);
`,
};
