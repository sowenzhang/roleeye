import { ExitCode } from '../util/errors.js';
import { runScreening } from '../evaluate/screen.js';
import { flagBool, flagNumber } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * Deterministic screening over everything already stored.
 *
 * No model is involved, so this is free, fast, and safe to schedule. It is the
 * gate that decides which roles are ever worth spending money on.
 */
export const screenCommand: Command = {
  name: 'screen',
  summary: 'Apply hard filters and authenticity checks to stored roles',
  usage: 'roleeye screen [--force] [--limit <n>] [--json]',

  run(context: CommandContext) {
    const config = context.loadConfig();
    const { repos } = context.openDb();

    const summary = runScreening(repos, {
      criteria: config.criteria,
      force: flagBool(context.args, 'force'),
      limit: flagNumber(context.args, 'limit'),
    });

    if (context.json) {
      printJson(context, summary);
      return ExitCode.Ok;
    }

    printLine(context, 'Screening');
    printLine(context);
    printLine(context, `  ${summary.screened} screened, ${summary.reused} already current`);
    printLine(context, `  ${summary.eligible} eligible, ${summary.rejected} rejected by your rules`);

    if (summary.blocked > 0) {
      printLine(context, `  ${summary.blocked} blocked for high fraud risk`);
    }

    const rules = Object.entries(summary.rejectionsByRule).sort(([, a], [, b]) => b - a);
    if (rules.length > 0) {
      printLine(context);
      printLine(context, '  Rejected by:');
      for (const [rule, count] of rules) {
        printLine(context, `    ${rule.padEnd(20)} ${count}`);
      }
    }

    printLine(context);
    printLine(
      context,
      summary.eligible > 0
        ? 'Inspect any role with `roleeye verify <job-id>`.'
        : 'Nothing is eligible. Loosen config/criteria.yaml, or widen your sources.',
    );

    return ExitCode.Ok;
  },
};
