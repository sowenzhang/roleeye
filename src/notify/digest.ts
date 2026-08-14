import type { NotifyConfig } from '../config/notify-schema.js';
import type { Repositories } from '../db/repositories/index.js';
import { truncate } from '../normalize/text.js';
import type { Notification, NotificationItem } from './notifier.js';

/**
 * Builds the daily digest from the local record.
 *
 * Selection happens here, once, so every channel says the same thing. The
 * thresholds are the user's: a notifier that fires on everything gets muted,
 * and a muted notifier is worse than none because it still looks like it works.
 */

const RANK: Record<string, number> = { APPLY: 3, MAYBE: 2, SKIP: 1 };

export function meetsThreshold(decision: string, score: number, config: NotifyConfig): boolean {
  if (score < config.min_score) return false;
  if (config.min_decision === 'ANY') return true;

  return (RANK[decision] ?? 0) >= (RANK[config.min_decision] ?? 3);
}

export interface DigestInput {
  repos: Repositories;
  config: NotifyConfig;
  /** Only consider verdicts reached after this moment. */
  since: string;
  now: string;
}

export function buildDigest(input: DigestInput): Notification | undefined {
  const { repos, config } = input;

  const decisions = config.min_decision === 'APPLY' ? (['APPLY'] as const) : (['APPLY', 'MAYBE'] as const);

  const recommendations = repos.evaluations
    .listRecommendations(100, [...decisions])
    .filter((entry) => entry.createdAt >= input.since)
    .filter((entry) => meetsThreshold(entry.decision, entry.score, config));

  if (recommendations.length === 0 && !config.notify_on_empty) return undefined;

  const items: NotificationItem[] = recommendations.slice(0, config.max_items).map((entry) => {
    const job = repos.jobs.findById(entry.jobId);
    // The canonical link lives on the posting, since one role can be advertised
    // on several boards.
    const posting = repos.postings.listForJob(entry.jobId)[0];

    return {
      jobId: entry.jobId,
      company: job?.companyName ?? 'unknown company',
      title: job?.title ?? 'unknown role',
      decision: entry.decision,
      score: entry.score,
      headline: truncate(entry.headline ?? '', 160),
      url: posting?.canonicalUrl ?? posting?.sourceUrl,
    };
  });

  const summary =
    recommendations.length === 0
      ? 'RoleEye: nothing new worth your time'
      : `RoleEye: ${recommendations.length} role${recommendations.length === 1 ? '' : 's'} worth a look`;

  const detail =
    items.length === 0
      ? 'No role met your notification threshold in this period.'
      : items
          .map((item) => `${item.decision} ${item.score}  ${item.company} — ${item.title}\n    ${item.headline}`)
          .join('\n\n');

  return {
    kind: 'digest',
    summary,
    detail,
    items,
    // Always a local command: the record is on this machine, not in the message.
    reviewHint: 'Run `roleeye recommend` to see the full reasoning.',
    occurredAt: input.now,
  };
}

export function buildErrorNotification(message: string, now: string): Notification {
  return {
    kind: 'error',
    summary: 'RoleEye: a scheduled run failed',
    detail: message,
    items: [],
    reviewHint: 'Run `roleeye doctor` to check configuration and sources.',
    occurredAt: now,
  };
}
