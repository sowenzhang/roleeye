import type { JobEventType } from '../core/types.js';
import { daysBetween, type IsoTimestamp } from '../util/time.js';

export interface RepostInput {
  /** Last time any source reported this job. */
  lastSeenAt: IsoTimestamp;
  /** Set when a previous scan concluded the posting was gone. */
  closedAt: IsoTimestamp | undefined;
  previousSourceJobId: string | undefined;
  currentSourceJobId: string | undefined;
  previousDescriptionHash: string;
  currentDescriptionHash: string;
  seenAt: IsoTimestamp;
  /** Gap after which reappearance counts as a repost. */
  repostGapDays: number;
}

export interface RepostDecision {
  eventType: JobEventType;
  reason: string | undefined;
}

/**
 * Classifies what happened to a job we have already stored.
 *
 * A repost is the same logical role appearing again, not a new opportunity, so
 * we record an event instead of losing the original first_seen timestamp.
 */
export function classifyReappearance(input: RepostInput): RepostDecision {
  const gapDays = daysBetween(input.lastSeenAt, input.seenAt);
  const descriptionChanged = input.previousDescriptionHash !== input.currentDescriptionHash;

  if (input.closedAt) {
    return { eventType: 'reposted', reason: 'posting reappeared after being marked closed' };
  }

  if (
    input.previousSourceJobId &&
    input.currentSourceJobId &&
    input.previousSourceJobId !== input.currentSourceJobId
  ) {
    return { eventType: 'reposted', reason: 'source job id changed' };
  }

  if (gapDays >= input.repostGapDays) {
    return {
      eventType: 'reposted',
      reason: `not seen for ${Math.round(gapDays)} days (threshold ${input.repostGapDays})`,
    };
  }

  if (descriptionChanged) {
    return { eventType: 'changed', reason: 'description changed' };
  }

  return { eventType: 'seen_again', reason: undefined };
}
