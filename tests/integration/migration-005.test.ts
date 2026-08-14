import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { migrations, runMigrations } from '../../src/db/migrations/index.js';
import { migration005 } from '../../src/db/migrations/005-facts-and-artifacts.js';

/**
 * Migration 005 rebuilds `artifacts`.
 *
 * Migration 003 taught this codebase that a table rebuild has to be verified
 * against a populated database rather than an empty one: the interesting
 * failures are dropped rows and orphaned references, and neither can happen
 * when there is nothing in the table.
 */

function migrateTo(version: number): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');

  const previous = [...migrations];
  const upTo = previous.filter((migration) => migration.version <= version);

  db.pragma('foreign_keys = OFF');
  for (const migration of upTo) db.exec(migration.sql);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const migration of upTo) {
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      migration.version,
      migration.name,
      '2026-08-14T00:00:00.000Z',
    );
  }
  db.pragma('foreign_keys = ON');

  return db;
}

describe('migration 005', () => {
  it('carries existing artifacts forward instead of dropping them', () => {
    const db = migrateTo(4);

    db.prepare(
      `INSERT INTO companies (id, name, normalized_name, created_at)
       VALUES ('co_1', 'Acme', 'acme', '2026-08-01T00:00:00.000Z')`,
    ).run();

    db.prepare(
      `INSERT INTO jobs (id, company_id, title, normalized_title, employment_type, work_arrangement,
         description_text, description_hash, has_body, fingerprint, cluster_key, in_scope,
         first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ('job_1', 'co_1', 'Staff Engineer', 'staff engineer', 'full-time', 'remote',
         'body', 'hash', 1, 'fp', 'ck', 1,
         '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run();

    db.prepare(
      `INSERT INTO artifacts (id, job_id, type, path, checksum, created_at)
       VALUES ('art_1', 'job_1', 'evaluation', 'artifacts/acme/job_1/evaluation.md', 'sum', '2026-08-02T00:00:00.000Z')`,
    ).run();

    db.pragma('foreign_keys = OFF');
    db.exec(migration005.sql);
    db.pragma('foreign_keys = ON');

    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get('art_1') as
      | { job_id: string; path: string; generation_id: string | null; content_hash: string | null }
      | undefined;

    assert.ok(row, 'the existing artifact survived the rebuild');
    assert.equal(row.job_id, 'job_1');
    assert.equal(row.path, 'artifacts/acme/job_1/evaluation.md');
    assert.equal(row.generation_id, null, 'the new columns are unknown for old rows, not invented');

    const violations = db.pragma('foreign_key_check') as unknown[];
    assert.equal(violations.length, 0);

    db.close();
  });

  it('applies cleanly from empty and leaves no foreign key violations', () => {
    const db = new BetterSqlite3(':memory:');
    const applied = runMigrations(db);

    assert.ok(applied.includes(5));
    assert.equal((db.pragma('foreign_key_check') as unknown[]).length, 0);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name,
    );

    for (const table of ['experiences', 'facts', 'fact_imports', 'archetype_assignments', 'resume_generations', 'resume_claims']) {
      assert.ok(tables.includes(table), `${table} exists`);
    }

    db.close();
  });

  it('refuses two facts with the same statement', () => {
    const db = new BetterSqlite3(':memory:');
    runMigrations(db);

    const insert = db.prepare(
      `INSERT INTO facts (id, statement, statement_hash, created_at, updated_at)
       VALUES (?, ?, ?, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z')`,
    );

    insert.run('fact_1', 'Rebuilt the ledger.', 'hash-1');
    assert.throws(() => insert.run('fact_2', 'Rebuilt the ledger.', 'hash-1'), /UNIQUE/);

    db.close();
  });

  it('will not record an approved fact with no approval time', () => {
    const db = new BetterSqlite3(':memory:');
    runMigrations(db);

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO facts (id, statement, statement_hash, status, created_at, updated_at)
             VALUES ('fact_1', 'Rebuilt the ledger.', 'hash-1', 'approved', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z')`,
          )
          .run(),
      /CHECK/,
    );

    db.close();
  });
});
