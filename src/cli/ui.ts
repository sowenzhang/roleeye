import { ExitCode } from '../util/errors.js';
import { resolvePaths } from '../config/paths.js';
import { ConfigService } from '../portal/config-service.js';
import { createRoutes } from '../portal/routes.js';
import { renderIndex } from '../portal/index-page.js';
import { startPortal } from '../portal/server.js';
import { flagBool, flagNumber } from './args.js';
import { printLine, type Command, type CommandContext } from './command.js';

/**
 * The configuration portal.
 *
 * YAML is a good storage format and a poor authoring format. This is a client
 * over the same modules the CLI uses — it writes the same files, validated by
 * the same schemas — so the two can never disagree about what your settings
 * mean.
 */
export const uiCommand: Command = {
  name: 'ui',
  summary: 'Open the local configuration portal',
  usage: 'roleeye ui [--port <n>] [--no-open]',

  async run(context: CommandContext) {
    const paths = resolvePaths(context.root);
    const config = new ConfigService(paths);

    const portal = await startPortal({
      port: flagNumber(context.args, 'port') ?? 7777,
      logger: context.logger,
      index: renderIndex,
      routes: createRoutes({
        config,
        logger: context.logger,
        loadConfig: () => context.loadConfig({ allowDefaults: true }),
        openDb: () => context.openDb(),
      }),
    });

    printLine(context, 'RoleEye configuration portal');
    printLine(context);
    printLine(context, `  ${portal.url}`);
    printLine(context);
    printLine(context, '  Bound to 127.0.0.1 only. The token in the URL authorizes changes.');
    printLine(context, '  Press Ctrl+C to stop.');

    if (flagBool(context.args, 'open', true)) {
      await openInBrowser(portal.url, context);
    }

    await new Promise<void>((resolve) => {
      const stop = (): void => {
        void portal.close().then(resolve);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });

    printLine(context);
    printLine(context, 'Portal stopped.');
    return ExitCode.Ok;
  },
};

/** Best effort: a browser that will not open is not a failure worth an error. */
async function openInBrowser(url: string, context: CommandContext): Promise<void> {
  const { spawn } = await import('node:child_process');

  const command =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };

  try {
    const child = spawn(command.file, command.args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    context.logger.debug('could not open a browser automatically');
  }
}
