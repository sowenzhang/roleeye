import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../util/logger.js';
import { runMigrations } from './migrations/index.js';

export type Database = BetterSqlite3.Database;

export interface OpenDatabaseOptions {
  /** File path, or ':memory:' for tests. */
  path: string;
  readonly?: boolean;
  migrate?: boolean;
  logger?: Logger;
}

/**
 * Opens the local SQLite database — the authoritative store for the whole
 * system. WAL mode keeps a long scan from blocking reads in another terminal.
 */
export function openDatabase(options: OpenDatabaseOptions): Database {
  const { path: dbPath, readonly = false, migrate = true, logger } = options;

  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
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
