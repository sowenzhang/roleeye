import type BetterSqlite3 from 'better-sqlite3';
import { migration001, type Migration } from './001-initial.js';
import { nowIso } from '../../util/time.js';
import type { Logger } from '../../util/logger.js';

/** Ordered list of migrations. Append only; never edit an applied migration. */
export const migrations: readonly Migration[] = [migration001];

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

/** Applies pending migrations, each in its own transaction. Returns applied versions. */
export function runMigrations(db: BetterSqlite3.Database, logger?: Logger): number[] {
  const pending = pendingMigrations(db);
  const applied: number[] = [];

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

  return applied;
}
