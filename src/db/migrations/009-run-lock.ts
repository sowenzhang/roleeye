import type { Migration } from './001-initial.js';

/**
 * One run at a time, across every process on this machine.
 *
 * The portal, a terminal, and the scheduled task at 07:30 are three separate
 * processes. Two of them running the pipeline at once interleave source runs
 * over this very database and — the part that costs real money — each build
 * their own budget guard, so a per-run spending cap applies twice over the same
 * window.
 *
 * The lock lives here, in SQLite, rather than in a lock file, because a lock
 * file cannot be made correct with the primitives Node exposes. `openSync` with
 * "wx" is an atomic *create*, which is not the same as atomic ownership: two
 * processes that both judge a lock stale can both delete it and both create it,
 * and a release that reads-then-deletes can remove a successor's lock in the
 * gap between the two calls. SQLite already takes real file locks and gives us
 * a compare-and-set inside a transaction, which is exactly the primitive the
 * problem needs — and it is the resource being protected in the first place.
 *
 * A single row, enforced by the CHECK: the lock is a property of this database,
 * not a set of things to reconcile.
 */
export const migration009: Migration = {
  version: 9,
  name: 'run-lock',
  sql: `
CREATE TABLE IF NOT EXISTS run_lock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  -- Random per acquisition. Identity cannot rest on a process id: those are
  -- reused, and a reused one would let a stranger release or refresh a lock.
  owner        TEXT    NOT NULL,
  pid          INTEGER NOT NULL,
  host         TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  started_at   TEXT    NOT NULL,
  -- Refreshed while the run is going. The only evidence available when the
  -- holder is on another machine and its process id means nothing here.
  heartbeat_at TEXT    NOT NULL
);
`,
};
