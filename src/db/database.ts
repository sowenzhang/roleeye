import BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../util/logger.js';
import { backupDatabase } from '../util/backup.js';
import { pendingMigrations, runMigrations } from './migrations/index.js';

export type Database = BetterSqlite3.Database;

export interface OpenDatabaseOptions {
  /** File path, or ':memory:' for tests. */
  path: string;
  readonly?: boolean;
  migrate?: boolean;
  /** Disables the automatic pre-migration snapshot. Tests use this. */
  backupBeforeMigrate?: boolean;
  logger?: Logger;
}

/**
 * Opens the local SQLite database — the authoritative store for the whole
 * system. WAL mode keeps a long scan from blocking reads in another terminal.
 */
export function openDatabase(options: OpenDatabaseOptions): Database {
  const { path: dbPath, readonly = false, migrate = true, backupBeforeMigrate = true, logger } = options;

  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  // A schema change is the likeliest way to lose the only copy of the data, so
  // snapshot first and only then migrate.
  if (migrate && !readonly && backupBeforeMigrate && dbPath !== ':memory:' && existsSync(dbPath)) {
    const probe = new BetterSqlite3(dbPath, { readonly: true });
    let pending = 0;
    try {
      pending = pendingMigrations(probe).length;
    } catch {
      pending = 0;
    } finally {
      probe.close();
    }

    if (pending > 0) {
      try {
        const result = backupDatabase({ dbPath, label: 'pre-migration', logger });
        if (!result.skipped) {
          logger?.info('pre-migration backup written', { path: result.path, bytes: result.bytes });
        }
      } catch (error) {
        // A schema change without a snapshot is exactly the risk this guards.
        throw new Error(
          `refusing to migrate without a backup: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const db = new BetterSqlite3(dbPath, { readonly });

  if (!readonly) {
    if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  if (migrate && !readonly) {
    const applied = runMigrations(db, logger);
    if (applied.length > 0) {
      logger?.info('database migrated', { applied: applied.join(','), path: dbPath });
    }
  }

  return db;
}

/** Wraps a function in a transaction. */
export function withTransaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn)();
}

export function closeDatabase(db: Database): void {
  try {
    db.close();
  } catch {
    // Already closed; nothing meaningful to recover.
  }
}
