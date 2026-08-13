import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Logger } from './logger.js';

/**
 * Snapshots the authoritative database.
 *
 * The local database is declared the source of truth and never deletes history,
 * which makes it the single point of failure for months of accumulated data. A
 * backup is taken automatically before every migration, because a schema change
 * is the most likely way to lose it.
 */

export interface BackupResult {
  path: string;
  bytes: number;
  skipped: boolean;
}

export interface BackupOptions {
  dbPath: string;
  /** Defaults to a `backups` directory beside the database. */
  directory?: string | undefined;
  label?: string | undefined;
  /** Backups to retain; older ones are pruned. */
  keep?: number | undefined;
  logger?: Logger | undefined;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

export function backupDirectoryFor(dbPath: string, directory?: string | undefined): string {
  return directory ?? path.join(path.dirname(path.resolve(dbPath)), 'backups');
}

/**
 * Snapshots the database with `VACUUM INTO`.
 *
 * That statement is synchronous and produces a single consistent file, so the
 * caller can be certain the snapshot exists before a migration starts. A plain
 * file copy would risk missing committed pages still living in the -wal file.
 */
export function backupDatabase(options: BackupOptions): BackupResult {
  const { dbPath, logger } = options;

  if (dbPath === ':memory:' || !existsSync(dbPath)) {
    return { path: '', bytes: 0, skipped: true };
  }

  const directory = backupDirectoryFor(dbPath, options.directory);
  mkdirSync(directory, { recursive: true });

  const label = options.label ? `-${options.label}` : '';
  const target = path.join(directory, `roleeye-${timestamp()}${label}.db`);

  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const bytes = statSync(target).size;
  logger?.debug('database backed up', { target, bytes });

  pruneBackups(directory, options.keep ?? 10);

  return { path: target, bytes, skipped: false };
}

/** Keeps the newest N backups so the directory cannot grow without bound. */
export function pruneBackups(directory: string, keep: number): string[] {
  if (keep <= 0 || !existsSync(directory)) return [];

  const files = readdirSync(directory)
    .filter((name) => name.startsWith('roleeye-') && name.endsWith('.db'))
    .map((name) => path.join(directory, name))
    .sort()
    .reverse();

  const removed: string[] = [];
  for (const file of files.slice(keep)) {
    try {
      unlinkSync(file);
      removed.push(file);
    } catch {
      // A locked or already-removed file must not fail the backup.
    }
  }

  return removed;
}
