import type BetterSqlite3 from 'better-sqlite3';
import { migration001, type Migration } from './001-initial.js';
import { migration002 } from './002-scope.js';
import { migration003 } from './003-source-postings.js';
import { migration004 } from './004-screening.js';
import { migration005 } from './005-facts-and-artifacts.js';
import { migration006 } from './006-fact-identity.js';
import { migration007 } from './007-applications.js';
import { nowIso } from '../../util/time.js';
import type { Logger } from '../../util/logger.js';

/** Ordered list of migrations. Append only; never edit an applied migration. */
export const migrations: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
];

export type { Migration };

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

export function appliedVersions(db: BetterSqlite3.Database): number[] {
  db.exec(MIGRATIONS_TABLE);
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[];
  return rows.map((row) => row.version);
}

export function pendingMigrations(db: BetterSqlite3.Database): Migration[] {
  const applied = new Set(appliedVersions(db));
  return migrations.filter((migration) => !applied.has(migration.version));
}

/**
 * Applies pending migrations, each in its own transaction. Returns applied versions.
 *
 * Foreign key enforcement is suspended around the batch because SQLite table
 * rebuilds (drop and rename) would otherwise trip references mid-migration, and
 * `PRAGMA foreign_keys` is a no-op inside a transaction. Integrity is verified
 * afterwards rather than assumed.
 */
export function runMigrations(db: BetterSqlite3.Database, logger?: Logger): number[] {
  const pending = pendingMigrations(db);
  if (pending.length === 0) return [];

  const foreignKeysWereOn = Boolean(db.pragma('foreign_keys', { simple: true }));
  if (foreignKeysWereOn) db.pragma('foreign_keys = OFF');

  const applied: number[] = [];

  try {
    for (const migration of pending) {
      const apply = db.transaction(() => {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          migration.version,
          migration.name,
          nowIso(),
        );
      });

      apply();
      applied.push(migration.version);
      logger?.debug('migration applied', { version: migration.version, name: migration.name });
    }

    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(`migration left ${violations.length} foreign key violation(s)`);
    }
  } finally {
    if (foreignKeysWereOn) db.pragma('foreign_keys = ON');
  }

  return applied;
}
