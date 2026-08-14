import { ExitCode, UsageError, type ExitCodeValue } from '../util/errors.js';
import { ask } from '../search/planner.js';
import { singleLine, truncate } from '../normalize/text.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * Ask a question about your own record.
 *
 * Deterministic, and it shows its work: every answer names the plan it chose,
 * why, and the `roleeye search` or `roleeye stats` command that reproduces it.
 * A question-answering interface that cannot be checked is one you have to
 * trust, and there is nothing here worth trusting that cannot be verified in a
 * second command.
 *
 * No model is called. Phase 7 may add one to *explain* these results; it will
 * not be allowed to compute them (architecture.md §22).
 */
export const askCommand: Command = {
  name: 'ask',
  summary: 'Answer a question from your own records',
  usage: 'roleeye ask "<question>" [--json]',

  run(context: CommandContext): ExitCodeValue {
    const question = context.args.positionals.join(' ').trim();
    if (!question) throw new UsageError('usage: roleeye ask "<question>"');

    const { db } = context.openDb();
    const answer = ask(db, question);

    if (context.json) {
      printJson(context, answer);
      return answer.unanswerable ? ExitCode.CompletedWithWarnings : ExitCode.Ok;
    }

    printLine(context, `${answer.plan.kind}  —  ${answer.plan.because}`);
    printLine(context);

    if (answer.unanswerable) {
      printLine(context, `  ${answer.unanswerable}`);
      printLine(context);
      printLine(context, `  Closest thing that works today:`);
      printLine(context, `    ${answer.plan.equivalent}`);
      return ExitCode.CompletedWithWarnings;
    }

    if (answer.analytics) {
      for (const [stage, value] of Object.entries(answer.analytics.counts)) {
        printLine(context, `  ${stage.replace(/_/g, ' ').padEnd(17)} ${String(value).padStart(6)}`);
      }

      const rates = Object.entries(answer.analytics.rates).filter(([, value]) => value !== undefined);
      if (rates.length > 0) {
        printLine(context);
        for (const [name, value] of rates) {
          printLine(context, `  ${name.replace(/([A-Z])/g, ' $1').toLowerCase().padEnd(24)} ${((value as number) * 100).toFixed(0)}%`);
        }
      }

      if (answer.analytics.segments) {
        printLine(context);
        for (const row of answer.analytics.segments) {
          printLine(
            context,
            `  ${truncate(row.segment, 24).padEnd(24)} ${String(row.applications).padStart(4)} applied, ` +
              `${row.screens} screened, ${row.offers} offer(s)`,
          );
        }
      }

      printLine(context);
      printLine(context, `  Reproduce: ${answer.plan.equivalent}`);
      return ExitCode.Ok;
    }

    if (answer.hits.length === 0) {
      printLine(context, '  Nothing in the record answers that.');
      printLine(context);
      printLine(context, `  Reproduce: ${answer.plan.equivalent}`);
      return ExitCode.NotFound;
    }

    printLine(context, `  ${answer.hits.length} record(s):`);

    for (const hit of answer.hits) {
      printLine(context);
      printLine(context, `  ${hit.company ? `${hit.company} — ` : ''}${truncate(hit.title, 66)}`);

      // Facts come from the record, never from the text that matched.
      const facts = [
        hit.firstSeenAt ? `first seen ${hit.firstSeenAt.slice(0, 10)}` : undefined,
        hit.decision ? `decision ${hit.decision}` : undefined,
        hit.appliedAt ? `applied ${hit.appliedAt.slice(0, 10)}` : undefined,
        hit.status ? `status ${hit.status}` : undefined,
        hit.jobId,
      ].filter(Boolean);

      printLine(context, `    ${facts.join('  ')}`);
      if (hit.excerpt) printLine(context, `    ${truncate(singleLine(hit.excerpt), 140)}`);
    }

    printLine(context);
    printLine(context, `  Reproduce: ${answer.plan.equivalent}`);

    return ExitCode.Ok;
  },
};
