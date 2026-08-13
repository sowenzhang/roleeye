import { z } from 'zod';

/**
 * Screening configuration.
 *
 * These blocks extend `config/criteria.yaml`. They are user data, never
 * hard-coded business logic, and every threshold has a documented default so an
 * existing config keeps working.
 */

/** What to do when a filter cannot be evaluated because data is missing. */
export const unknownPolicySchema = z.enum(['allow', 'reject', 'flag']);

export type UnknownPolicy = z.infer<typeof unknownPolicySchema>;

export const screeningSchema = z
  .object({
    enabled: z.boolean().default(true),
    /**
     * Days a posting must have been observed before longitudinal signals may
     * speak. Below this, freshness and hiring intent report `unknown` instead of
     * inventing confidence from a single sighting.
     */
    observation_window_days: z.number().int().positive().default(21),
    /** Continuously open beyond this many days counts as stale. */
    stale_after_days: z.number().int().positive().default(60),
    /** Reposts within the window that suggest an evergreen pipeline ad. */
    evergreen_repost_threshold: z.number().int().positive().default(3),
    /** Bodies shorter than this are too thin to be a real description. */
    minimum_description_chars: z.number().int().nonnegative().default(400),
    /** Identical text under this many distinct companies is a content farm. */
    duplicate_company_threshold: z.number().int().positive().default(3),
    /** High fraud risk stops the pipeline for that role. */
    block_on_high_fraud_risk: z.boolean().default(true),
  })
  .strict()
  .default({
    enabled: true,
    observation_window_days: 21,
    stale_after_days: 60,
    evergreen_repost_threshold: 3,
    minimum_description_chars: 400,
    duplicate_company_threshold: 3,
    block_on_high_fraud_risk: true,
  });

export type ScreeningConfig = z.infer<typeof screeningSchema>;

export const budgetSchema = z
  .object({
    max_jobs_per_scan: z.number().int().positive().default(40),
    max_cost_per_scan_usd: z.number().nonnegative().default(1),
    max_cost_per_month_usd: z.number().nonnegative().default(20),
    on_exhausted: z.enum(['stop', 'warn']).default('stop'),
  })
  .strict()
  .default({
    max_jobs_per_scan: 40,
    max_cost_per_scan_usd: 1,
    max_cost_per_month_usd: 20,
    on_exhausted: 'stop',
  });

export type BudgetConfig = z.infer<typeof budgetSchema>;

export const unknownHandlingSchema = z
  .object({
    salary: unknownPolicySchema.default('flag'),
    country: unknownPolicySchema.default('flag'),
  })
  .strict()
  .default({ salary: 'flag', country: 'flag' });

export type UnknownHandling = z.infer<typeof unknownHandlingSchema>;
