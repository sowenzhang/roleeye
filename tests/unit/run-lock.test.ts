import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { describe, it } from 'node:test';
import { acquireRunLock, describeLock, readRunLock } from '../../src/core/run-lock.js';
import { openDatabase, type Database } from '../../src/db/database.js';

/**
 * One run at a time, across every process on this machine.
 *
 * The portal's own guard lives in one process's memory and knows nothing about
 * the scheduled `roleeye run` firing at 07:30. Two overlapping runs interleave
 * source runs in this very database and each build their own budget guard, so
 * the per-run spending cap applies twice over the same window.
 *
 * The lock lives in SQLite because a lock *file* cannot be made correct with
 * what Node exposes: an atomic create is not atomic ownership, and two
 * processes that both judge a file stale can both unlink it and both recreate
 * it. These cover the cases that protocol got wrong.
 */

function db(): Database {
  return openDatabase({ path: ':memory:' });
}

/** A lock left by some other process, written directly. */
function plant(
  handle: Database,
  over: { pid?: number; host?: string; heartbeatAt?: string; kind?: string } = {},
): void {
  handle
    .prepare(
      `INSERT INTO run_lock (id, owner, pid, host, kind, started_at, heartbeat_at)
       VALUES (1, 'someone-else', @pid, @host, @kind, @started, @beat)
       ON CONFLICT(id) DO UPDATE SET
         owner = 'someone-else', pid = @pid, host = @host, kind = @kind,
         started_at = @started, heartbeat_at = @beat`,
    )
    .run({
      pid: over.pid ?? 4242,
      host: over.host ?? hostname(),
      kind: over.kind ?? 'cli',
      started: new Date().toISOString(),
      beat: over.heartbeatAt ?? new Date().toISOString(),
    });
}

const NEVER_ALIVE = () => false;
const ALWAYS_ALIVE = () => true;

describe('the run lock', () => {
  it('lets exactly one holder in', () => {
    const handle = db();

    const first = acquireRunLock(handle, 'portal');
    assert.equal(first.ok, true);

    const second = acquireRunLock(handle, 'cli');
    assert.equal(second.ok, false);
    if (second.ok) return;

    assert.equal(second.held?.kind, 'portal', 'the refusal names who is holding it');
    assert.match(second.reason, /still going/i);
    handle.close();
  });

  it('lets the next run in once the first releases', () => {
    const handle = db();

    const first = acquireRunLock(handle, 'cli');
    assert.equal(first.ok, true);
    if (!first.ok) return;

    first.lock.release();
    assert.equal(readRunLock(handle), undefined);
    assert.equal(acquireRunLock(handle, 'portal').ok, true);
    handle.close();
  });

  it('never treats a live local run as stale, however quiet it has been', () => {
    // Screening and ingest are synchronous loops, so a busy run can starve its
    // own heartbeat timer. Expiring it on silence would hand the lock to a
    // second process while the first was still writing — exactly the overlap
    // this exists to prevent.
    const handle = db();
    plant(handle, { heartbeatAt: new Date(Date.now() - 60 * 60_000).toISOString() });

    const result = acquireRunLock(handle, 'portal', { alive: ALWAYS_ALIVE });

    assert.equal(result.ok, false, 'an hour of silence from a living process is still a held lock');
    assert.ok(readRunLock(handle, { alive: ALWAYS_ALIVE }));
    handle.close();
  });

  it('reclaims a lock whose local process is gone, without waiting', () => {
    const handle = db();
    plant(handle);

    assert.equal(readRunLock(handle, { alive: NEVER_ALIVE }), undefined);
    assert.equal(acquireRunLock(handle, 'portal', { alive: NEVER_ALIVE }).ok, true);
    handle.close();
  });

  it('waits out a lock held by another machine rather than assuming it is dead', () => {
    // On a shared database the recorded process id means nothing here, so the
    // heartbeat is the only honest signal.
    const handle = db();
    plant(handle, { host: 'some-other-laptop', pid: 999_999 });

    const result = acquireRunLock(handle, 'portal', { alive: NEVER_ALIVE });
    assert.equal(result.ok, false, 'a local liveness check must not judge a foreign process');
    if (result.ok) return;
    assert.match(result.reason, /some-other-laptop/);
    handle.close();
  });

  it('reclaims a foreign lock that has stopped beating', () => {
    const handle = db();
    plant(handle, { host: 'some-other-laptop', heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() });

    assert.equal(acquireRunLock(handle, 'portal', { alive: NEVER_ALIVE }).ok, true);
    handle.close();
  });

  it('does not let a replaced holder release the lock that replaced it', () => {
    // The failure a lock file could not close: A is declared stale, B takes
    // over, then A's `finally` runs and deletes B's lock.
    const handle = db();

    const first = acquireRunLock(handle, 'cli');
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const second = acquireRunLock(handle, 'portal', { alive: NEVER_ALIVE });
    assert.equal(second.ok, true);
    if (!second.ok) return;

    first.lock.release();

    const held = readRunLock(handle, { alive: ALWAYS_ALIVE });
    assert.equal(held?.owner, second.lock.info.owner, "a stale holder cannot delete its successor's lock");
    handle.close();
  });

  it('does not let a replaced holder refresh the lock that replaced it', () => {
    const handle = db();

    const first = acquireRunLock(handle, 'cli');
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const second = acquireRunLock(handle, 'portal', { alive: NEVER_ALIVE });
    assert.equal(second.ok, true);
    if (!second.ok) return;

    const beat = handle
      .prepare('UPDATE run_lock SET heartbeat_at = ? WHERE id = 1 AND owner = ?')
      .run(new Date().toISOString(), first.lock.info.owner);

    assert.equal(beat.changes, 0, 'a heartbeat is scoped to its own claim');
    handle.close();
  });

  it('releases only once, however many times it is asked', () => {
    const handle = db();

    const first = acquireRunLock(handle, 'cli');
    assert.equal(first.ok, true);
    if (!first.ok) return;
    first.lock.release();

    const second = acquireRunLock(handle, 'portal');
    assert.equal(second.ok, true);

    first.lock.release();
    assert.ok(readRunLock(handle, { alive: ALWAYS_ALIVE }), 'a second release is a no-op');
    handle.close();
  });

  it('keeps exactly one lock row, whatever happens', () => {
    const handle = db();

    acquireRunLock(handle, 'cli');
    acquireRunLock(handle, 'portal', { alive: NEVER_ALIVE });
    acquireRunLock(handle, 'scan', { alive: NEVER_ALIVE });

    const count = handle.prepare('SELECT count(*) AS n FROM run_lock').get() as { n: number };
    assert.equal(count.n, 1, 'the lock is a property of the database, not a set to reconcile');
    handle.close();
  });

  it('says something useful when there is nothing to describe', () => {
    assert.match(describeLock(undefined), /another roleeye run/i);
  });
});
