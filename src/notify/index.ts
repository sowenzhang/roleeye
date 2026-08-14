import type { NotifyConfig } from '../config/notify-schema.js';
import { createDesktopNotifier } from './desktop.js';
import type { DeliveryResult, Notification, Notifier } from './notifier.js';
import { createWebhookNotifier } from './webhook.js';

/** Always available, and the only channel that works with nothing configured. */
export function createTerminalNotifier(write: (line: string) => void): Notifier {
  return {
    channel: 'terminal',
    async send(notification: Notification): Promise<DeliveryResult> {
      write(notification.summary);
      write('');
      write(notification.detail);
      write('');
      write(notification.reviewHint);
      return { channel: 'terminal', delivered: true };
    },
  };
}

export interface NotifierFactoryOptions {
  config: NotifyConfig;
  write: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the enabled channels.
 *
 * A channel that is enabled but unusable is reported at construction rather
 * than failing silently at 3am, which is the only time it matters.
 */
export function createNotifiers(options: NotifierFactoryOptions): { notifiers: Notifier[]; problems: string[] } {
  const { config } = options;
  const env = options.env ?? process.env;

  const notifiers: Notifier[] = [];
  const problems: string[] = [];

  if (config.channels.terminal) notifiers.push(createTerminalNotifier(options.write));

  if (config.channels.desktop) notifiers.push(createDesktopNotifier({ maxItems: config.max_items }));

  if (config.channels.webhook) {
    if (!config.webhook.url) {
      problems.push('webhook is enabled but notify.webhook.url is not set');
    } else {
      const token = config.webhook.token_env ? env[config.webhook.token_env] : undefined;
      if (config.webhook.token_env && !token) {
        problems.push(`webhook token not found in ${config.webhook.token_env}`);
      }

      notifiers.push(
        createWebhookNotifier({ url: config.webhook.url, token, timeoutMs: config.webhook.timeout_ms }),
      );
    }
  }

  if (notifiers.length === 0) problems.push('no notification channel is enabled');

  return { notifiers, problems };
}
