import { ExitCode, type ExitCodeValue } from '../util/errors.js';
import { acquireRunLock } from '../core/run-lock.js';
import type { Database } from '../db/database.js';
import { printLine, type CommandContext } from './command.js';

/**
 * Runs a command body with the cross-process run lock held.
 *
 * `runPipeline` takes the lock for anything that goes through it, but `scan`,
 * `screen` and `evaluate` are still commands in their own right and reach the
 * same work directly. `roleeye evaluate` is the one that matters: it builds its
 * own budget guard, so overlapping the scheduled run would apply the per-run
 * spending cap twice over the same window.
 *
 * A refusal is not a failure of this invocation — the work is already being
 * done by whoever holds the lock — but it is not a success either. It reports
 * "completed with warnings" so a scheduled task that keeps colliding is
 * visible rather than recorded as a clean run that quietly did nothing.
 */
export async function withRunLock(
  context: CommandContext,
  db: Database,
  kind: string,
  body: () => Promise<ExitCodeValue> | ExitCodeValue,
): Promise<ExitCodeValue> {
  const claim = acquireRunLock(db, kind);

  if (!claim.ok) {
    printLine(context, claim.reason);
    printLine(context, 'Nothing was changed. Wait for it to finish, or stop it, then try again.');
    return ExitCode.CompletedWithWarnings;
  }

  try {
    return await body();
  } finally {
    claim.lock.release();
  }
}
