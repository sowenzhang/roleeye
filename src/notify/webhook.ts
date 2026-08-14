import type { DeliveryResult, Notification, Notifier } from './notifier.js';

/**
 * Posts the notification as JSON to a URL the user controls.
 *
 * The destination is checked before anything is sent: a webhook is the one
 * channel that can carry the user's job search off the machine, so it must be
 * either encrypted or local, never plain http to somewhere else. The token is
 * read from the environment so it never lands in a config file.
 */

export function checkWebhookUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'webhook.url is not a valid URL' };
  }

  if (url.protocol === 'https:') return { ok: true, url };

  if (url.protocol === 'http:') {
    const host = url.hostname;
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    return loopback
      ? { ok: true, url }
      : { ok: false, reason: 'plain http is only allowed to localhost; use https for anywhere else' };
  }

  return { ok: false, reason: `unsupported scheme ${url.protocol}` };
}

export interface WebhookOptions {
  url: string;
  token: string | undefined;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export function createWebhookNotifier(options: WebhookOptions): Notifier {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    channel: 'webhook',

    async send(notification: Notification): Promise<DeliveryResult> {
      const checked = checkWebhookUrl(options.url);
      if (!checked.ok) return { channel: 'webhook', delivered: false, reason: checked.reason };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);

      try {
        const response = await fetchImpl(checked.url.toString(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify({
            kind: notification.kind,
            summary: notification.summary,
            detail: notification.detail,
            occurredAt: notification.occurredAt,
            reviewHint: notification.reviewHint,
            items: notification.items,
          }),
          signal: controller.signal,
          redirect: 'error',
        });

        return response.ok
          ? { channel: 'webhook', delivered: true }
          : { channel: 'webhook', delivered: false, reason: `webhook responded ${response.status}` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
