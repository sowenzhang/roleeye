/**
 * The notification boundary.
 *
 * One shape, several destinations. Adapters render it; they never decide what
 * is worth sending, because that decision belongs to configuration and must be
 * identical on every channel.
 *
 * Every item carries the job id it came from. A notification that cannot be
 * traced back to the local record is a claim the user cannot check
 * (architecture.md Phase 3.5).
 */

export type NotificationKind = 'digest' | 'error' | 'test';

export interface NotificationItem {
  jobId: string;
  company: string;
  title: string;
  decision: string;
  score: number;
  /** One line of why, already truncated for display. */
  headline: string;
  url: string | undefined;
}

export interface Notification {
  kind: NotificationKind;
  /** Short enough for a toast. */
  summary: string;
  /** Longer prose for terminal and webhook. */
  detail: string;
  items: NotificationItem[];
  /** How to see the full record locally. */
  reviewHint: string;
  occurredAt: string;
}

export interface DeliveryResult {
  channel: string;
  delivered: boolean;
  reason?: string;
}

export interface Notifier {
  readonly channel: string;
  send(notification: Notification): Promise<DeliveryResult>;
}

/**
 * Sends on every configured channel, and never lets one failure hide another.
 *
 * A desktop notifier that throws must not stop the webhook that would have
 * reached the user's phone, so failures are collected and reported rather than
 * propagated.
 */
export async function deliver(notifiers: Notifier[], notification: Notification): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];

  for (const notifier of notifiers) {
    try {
      results.push(await notifier.send(notification));
    } catch (error) {
      results.push({
        channel: notifier.channel,
        delivered: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
