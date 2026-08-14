import { ExitCode, type ExitCodeValue } from '../util/errors.js';
import { buildDigest, buildErrorNotification } from '../notify/digest.js';
import { createNotifiers } from '../notify/index.js';
import { deliver } from '../notify/notifier.js';
import { flagBool, flagNumber } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

/**
 * The daily digest.
 *
 * Printing and sending are the same code path: what you see in the terminal is
 * exactly what a scheduled run would deliver, so nobody has to wait until 3am
 * to find out what the message looks like.
 */
export const digestCommand: Command = {
  name: 'digest',
  summary: 'Summarise what is worth your attention, and optionally send it',
  usage: 'roleeye digest [--send] [--since-hours <n>] [--test] [--json]',

  async run(context: CommandContext): Promise<ExitCodeValue> {
    const config = context.loadConfig();
    const { repos } = context.openDb();

    const notify = config.criteria.notify;
    const now = new Date();
    const sinceHours = flagNumber(context.args, 'since-hours') ?? 24;
    const since = new Date(now.getTime() - sinceHours * 3_600_000).toISOString();

    const notification = flagBool(context.args, 'test')
      ? buildErrorNotification('This is a test notification from RoleEye.', now.toISOString())
      : buildDigest({ repos, config: notify, since, now: now.toISOString() });

    if (!notification) {
      if (context.json) {
        printJson(context, { sent: false, reason: 'nothing met the notification threshold' });
        return ExitCode.Ok;
      }
      printLine(context, `Nothing met your threshold in the last ${sinceHours}h.`);
      printLine(context, 'Lower notify.min_decision or notify.min_score to hear about more.');
      return ExitCode.Ok;
    }

    if (context.json) {
      printJson(context, notification);
      return ExitCode.Ok;
    }

    const send = flagBool(context.args, 'send') || flagBool(context.args, 'test');

    // Without --send this is a preview, so only the terminal channel runs.
    const { notifiers, problems } = createNotifiers({
      config: send ? notify : { ...notify, channels: { terminal: true, desktop: false, webhook: false } },
      write: (line) => printLine(context, line),
    });

    for (const problem of problems) context.logger.warn('notification channel unavailable', { detail: problem });

    const results = await deliver(notifiers, notification);

    if (send) {
      printLine(context);
      for (const result of results) {
        printLine(context, `  ${result.channel.padEnd(9)} ${result.delivered ? 'sent' : `not sent — ${result.reason}`}`);
      }
    }

    // A failed delivery is a real failure: the user would never learn otherwise.
    return results.some((result) => !result.delivered) && send ? ExitCode.CompletedWithWarnings : ExitCode.Ok;
  },
};
