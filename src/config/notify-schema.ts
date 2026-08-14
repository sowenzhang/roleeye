import { z } from 'zod';

/**
 * How the agent reaches you when nothing is watching.
 *
 * A scheduled run is useless if its result dies in a log file. Terminal output
 * is the default because it always works; desktop and webhook exist for the
 * unattended case, which is the normal case once scheduling is on.
 */
export const notifySchema = z
  .object({
    /** Nothing is sent unless a channel is enabled. */
    channels: z
      .object({
        terminal: z.boolean().default(true),
        desktop: z.boolean().default(false),
        webhook: z.boolean().default(false),
      })
      .strict()
      .default({ terminal: true, desktop: false, webhook: false }),

    /**
     * Only notify about roles worth interrupting someone for.
     *
     * A notifier that fires on everything is a notifier that gets muted, and a
     * muted notifier is worse than none because it looks like it is working.
     */
    min_decision: z.enum(['APPLY', 'MAYBE', 'ANY']).default('APPLY'),
    min_score: z.number().int().min(0).max(100).default(0),

    /** Cap on roles listed in one notification, so a toast stays readable. */
    max_items: z.number().int().positive().max(25).default(5),

    /** Send even when a run found nothing, so silence is distinguishable from failure. */
    notify_on_empty: z.boolean().default(false),

    /** Always notify when a run fails, regardless of thresholds. */
    notify_on_error: z.boolean().default(true),

    webhook: z
      .object({
        /** https anywhere, or http on the loopback interface. */
        url: z.string().url().optional(),
        /** Environment variable holding a bearer token; never the token itself. */
        token_env: z.string().optional(),
        timeout_ms: z.number().int().positive().default(10_000),
      })
      .strict()
      .default({ timeout_ms: 10_000 }),
  })
  .strict()
  .default({
    channels: { terminal: true, desktop: false, webhook: false },
    min_decision: 'APPLY',
    min_score: 0,
    max_items: 5,
    notify_on_empty: false,
    notify_on_error: true,
    webhook: { timeout_ms: 10_000 },
  });

export type NotifyConfig = z.infer<typeof notifySchema>;
