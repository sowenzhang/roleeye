import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Database } from '../db/database.js';

/**
 * One run at a time, across every process on this machine.
 *
 * The portal already refused to start a second run on top of its own, but that
 * guard lives in one process's memory and knows nothing about the scheduled
 * `roleeye run` firing at 07:30, or a second terminal. Two overlapping runs
 * interleave source runs in the same database and each build their own budget
 * guard, so a per-run spending cap applies twice over the same window.
 *
 * Held in SQLite rather than in a lock file. A lock file cannot be made correct
 * with what Node exposes: `openSync(path, 'wx')` is an atomic *create*, which
 * is not atomic *ownership*. Two processes that both judge a lock stale will
 * both unlink it and both create it, and a release that reads-then-deletes can
 * remove a successor's lock in the window between the two syscalls. SQLite
 * gives a genuine compare-and-set inside a transaction, and it is already the
 * resource under contention.
 *
 * Staleness needs two signals, and the order matters:
 *
 * - **Process liveness first**, when the host matches. A run that is alive is
 *   never stale, however long it has gone without a heartbeat. Screening and
 *   ingest are synchronous loops, so a busy run can starve its own timer; an
 *   implementation that checked the heartbeat first would hand the lock to a
 *   second process while the first was still writing.
 * - **A heartbeat**, for everything else. A process on another machine, or one
 *   whose id has been recycled, leaves nothing else to go on.
 */

const HEARTBEAT_MS = 30_000;
const STALE_AFTER_MS = 120_000;

export interface LockInfo {
  owner: string;
  pid: number;
  host: string;
  kind: string;
  startedAt: string;
  heartbeatAt: string;
}

export interface RunLock {
  info: LockInfo;
  release(): void;
}

export type AcquireResult =
  | { ok: true; lock: RunLock }
  | { ok: false; held: LockInfo | undefined; reason: string };

interface Row {
  owner: string;
  pid: number;
  host: string;
  kind: string;
  started_at: string;
  heartbeat_at: string;
}

function toInfo(row: Row): LockInfo {
  return {
    owner: row.owner,
    pid: row.pid,
    host: row.host,
    kind: row.kind,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
  };
}

/** Signal 0 tests for existence without touching the process. */
export function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(row: Row, now: number, alive: (pid: number) => boolean): boolean {
  // A live local process holds its lock regardless of how long it has been
  // since it last managed to run a timer callback.
  if (row.host === hostname()) return !alive(row.pid);

  const beat = Date.parse(row.heartbeat_at);
  return !Number.isFinite(beat) || now - beat > STALE_AFTER_MS;
}

export function describeLock(info: LockInfo | undefined): string {
  if (!info) return 'Another RoleEye run is in progress.';

  const started = new Date(info.startedAt);
  const when = Number.isNaN(started.getTime()) ? 'recently' : started.toLocaleTimeString();
  const where = info.host && info.host !== hostname() ? ` on ${info.host}` : '';

  return `Another RoleEye run (${info.kind}, process ${info.pid}${where}) started at ${when} and is still going.`;
}

export interface LockOptions {
  /** Swappable so a test can describe a process that is not this one. */
  alive?: ((pid: number) => boolean) | undefined;
}

/**
 * Reports a live lock without taking one.
 *
 * Lets the portal refuse up front with a useful message rather than starting a
 * run that dies a moment later. Advisory only: `acquireRunLock` decides.
 */
export function readRunLock(db: Database, options: LockOptions = {}): LockInfo | undefined {
  const row = db.prepare('SELECT * FROM run_lock WHERE id = 1').get() as Row | undefined;
  if (!row) return undefined;

  return isStale(row, Date.now(), options.alive ?? isRunning) ? undefined : toInfo(row);
}

export function acquireRunLock(db: Database, kind: string, options: LockOptions = {}): AcquireResult {
  const alive = options.alive ?? isRunning;
  const now = new Date().toISOString();

  const info: LockInfo = {
    owner: randomUUID(),
    pid: process.pid,
    host: hostname(),
    kind,
    startedAt: now,
    heartbeatAt: now,
  };

  /**
   * Read and claim in one transaction.
   *
   * `immediate` takes SQLite's write lock before the read, so two processes
   * cannot both see a missing or stale row and both go on to write one. This is
   * the entire reason the lock lives in the database rather than beside it.
   */
  const claim = db.transaction((): LockInfo | undefined => {
    const row = db.prepare('SELECT * FROM run_lock WHERE id = 1').get() as Row | undefined;

    if (row && !isStale(row, Date.now(), alive)) return toInfo(row);

    db.prepare(
      `INSERT INTO run_lock (id, owner, pid, host, kind, started_at, heartbeat_at)
       VALUES (1, @owner, @pid, @host, @kind, @startedAt, @heartbeatAt)
       ON CONFLICT(id) DO UPDATE SET
         owner = @owner, pid = @pid, host = @host, kind = @kind,
         started_at = @startedAt, heartbeat_at = @heartbeatAt`,
    ).run(info);

    return undefined;
  });

  const held = claim.immediate();
  if (held) return { ok: false, held, reason: describeLock(held) };

  // Both scoped by owner, so a holder that was correctly declared stale and
  // replaced can neither refresh nor delete the lock that replaced it.
  const beat = db.prepare('UPDATE run_lock SET heartbeat_at = ? WHERE id = 1 AND owner = ?');
  const drop = db.prepare('DELETE FROM run_lock WHERE id = 1 AND owner = ?');

  const timer = setInterval(() => {
    try {
      beat.run(new Date().toISOString(), info.owner);
    } catch {
      // A closed database at shutdown. The run is ending anyway.
    }
  }, HEARTBEAT_MS);

  // Never a reason for a process to stay alive.
  timer.unref?.();

  let released = false;
  return {
    ok: true,
    lock: {
      info,
      release: () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        try {
          drop.run(info.owner);
        } catch {
          // Nothing useful to do. A lock that outlives its process is reclaimed
          // by the liveness check the moment anybody asks for it.
        }
      },
    },
  };
}
