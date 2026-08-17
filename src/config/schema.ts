import { z } from 'zod';
import { budgetSchema, screeningSchema, unknownHandlingSchema } from './screening-schema.js';
import { reasoningSchema } from './reasoning-schema.js';
import { notifySchema } from './notify-schema.js';

const weightSchema = z.number().int().min(0).max(100);

/**
 * How much a category matters, 0-5.
 *
 * The authored form of `weights`. Asking someone to distribute 100 points
 * across seven categories is a puzzle, not a preference: "location: 100%" means
 * nothing, and nobody sets compensation to zero, so the constraint mostly
 * produces arithmetic. Importance is compiled into `weights`, which stays the
 * only thing scoring reads — so nothing downstream has to know this exists.
 */
const importanceSchema = z.number().int().min(0).max(5);

export const IMPORTANCE_LABELS = ['Ignore', 'Barely', 'Somewhat', 'Matters', 'Important', 'Critical'] as const;

const IMPORTANCE_KEYS = [
  'career_direction',
  'hands_on',
  'product_customer',
  'ai_relevance',
  'technical_domain',
  'location',
  'compensation',
] as const;

export type WeightKey = (typeof IMPORTANCE_KEYS)[number];

/**
 * Turns a 0-5 rating per category into integer weights totalling exactly 100.
 *
 * Largest-remainder, so the rounding error lands on the categories that care
 * least about it rather than silently inflating one. A rating of every category
 * at zero would leave nothing to score with, so it falls back to equal weight —
 * the honest reading of "none of this matters" is "all of it matters the same".
 */
export function compileWeights(importance: Partial<Record<WeightKey, number>>): Record<WeightKey, number> {
  const ratings = IMPORTANCE_KEYS.map((key) => Math.max(0, Math.min(5, Math.trunc(importance[key] ?? 3))));
  const total = ratings.reduce((sum, rating) => sum + rating, 0);
  const shares = total === 0 ? ratings.map(() => 1) : ratings;
  const sum = shares.reduce((running, share) => running + share, 0);

  const exact = shares.map((share) => (share / sum) * 100);
  const floors = exact.map((value) => Math.floor(value));
  let remaining = 100 - floors.reduce((running, value) => running + value, 0);

  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const result = [...floors];
  for (const entry of order) {
    if (remaining <= 0) break;
    result[entry.index] = (result[entry.index] ?? 0) + 1;
    remaining -= 1;
  }

  return Object.fromEntries(IMPORTANCE_KEYS.map((key, index) => [key, result[index] ?? 0])) as Record<
    WeightKey,
    number
  >;
}

/**
 * Recovers a 0-5 rating from weights written before importance existed.
 *
 * Approximate by definition, and it does not need to be exact: it only has to
 * put the sliders somewhere the user recognises as their own settings.
 */
export function inferImportance(weights: Partial<Record<WeightKey, number>>): Record<WeightKey, number> {
  const values = IMPORTANCE_KEYS.map((key) => weights[key] ?? 0);
  const highest = Math.max(...values, 1);

  return Object.fromEntries(
    IMPORTANCE_KEYS.map((key) => {
      const weight = weights[key] ?? 0;
      if (weight === 0) return [key, 0];
      return [key, Math.max(1, Math.min(5, Math.round((weight / highest) * 5)))];
    }),
  ) as Record<WeightKey, number>;
}

export const criteriaSchema = z
  .object({
    version: z.number().int().positive().default(1),
    profile_name: z.string().default('default'),
    decision_thresholds: z
      .object({
        apply: z.number().min(0).max(100).default(78),
        maybe: z.number().min(0).max(100).default(62),
      })
      .strict()
      .default({ apply: 78, maybe: 62 }),
    weights: z
      .object({
        career_direction: weightSchema.default(20),
        hands_on: weightSchema.default(15),
        product_customer: weightSchema.default(15),
        ai_relevance: weightSchema.default(15),
        technical_domain: weightSchema.default(15),
        location: weightSchema.default(10),
        compensation: weightSchema.default(10),
      })
      // Strict: an unrecognised weight would silently carry zero influence.
      .strict()
      .default({
        career_direction: 20,
        hands_on: 15,
        product_customer: 15,
        ai_relevance: 15,
        technical_domain: 15,
        location: 10,
        compensation: 10,
      }),
    /**
     * What the user actually chose, before it was normalised into `weights`.
     *
     * Optional so every existing file keeps loading. When present it is the
     * authored form and the portal shows it; `weights` remains what scoring
     * reads, so the two must be written together or not at all.
     */
    importance: z
      .object({
        career_direction: importanceSchema,
        hands_on: importanceSchema,
        product_customer: importanceSchema,
        ai_relevance: importanceSchema,
        technical_domain: importanceSchema,
        location: importanceSchema,
        compensation: importanceSchema,
      })
      .strict()
      .optional(),
    hard_filters: z
      .object({
        countries: z.array(z.string()).default([]),
        require_us_payroll: z.boolean().default(false),
        relocation: z.object({ reject_if_required: z.boolean().default(true) }).strict().default({
          reject_if_required: true,
        }),
        minimum_base_salary: z
          .object({
            amount: z.number().nonnegative(),
            currency: z.string().default('USD'),
          })
          .strict()
          .optional(),
        /** What a filter does when the posting does not state the fact it needs. */
        on_unknown: unknownHandlingSchema,
      })
      // Strict: a mistyped filter key is a rule the user believes is active and is not.
      .strict()
      .default({
        countries: [],
        require_us_payroll: false,
        relocation: { reject_if_required: true },
        on_unknown: { salary: 'flag', country: 'flag' },
      }),
    screening: screeningSchema,
    budget: budgetSchema,
    reasoning: reasoningSchema,
    notify: notifySchema,
    penalties: z.record(z.union([z.number(), z.record(z.number())])).default({}),
    preferences: z
      .object({
        work_arrangement: z.object({ preferred: z.array(z.string()).default([]) }).strict().default({ preferred: [] }),
        application_system: z.object({ deny: z.array(z.string()).default([]) }).strict().default({ deny: [] }),
        direction: z
          .object({
            positive: z.array(z.string()).default([]),
            negative: z.array(z.string()).default([]),
          })
          .strict()
          .default({ positive: [], negative: [] }),
      })
      .strict()
      .default({
        work_arrangement: { preferred: [] },
        application_system: { deny: [] },
        direction: { positive: [], negative: [] },
      }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const total = Object.values(value.weights).reduce((sum, weight) => sum + weight, 0);
    if (total !== 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weights'],
        message: `weights must total 100, got ${total}`,
      });
    }
    if (value.decision_thresholds.maybe > value.decision_thresholds.apply) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision_thresholds'],
        message: 'maybe threshold must be less than or equal to apply threshold',
      });
    }
  });

export type CriteriaConfig = z.infer<typeof criteriaSchema>;

/**
 * How much of a source's board is captured.
 *
 * A board routinely holds 50-400 postings, nearly all irrelevant to one person.
 * Capturing everything produces noise and cost; capturing nothing loses market
 * history. The mode lets the user choose per source.
 */
export const captureModeSchema = z.enum(['full', 'history', 'scoped']);

export type CaptureMode = z.infer<typeof captureModeSchema>;

const stringList = z.array(z.string()).default([]);

/** Scope fields, all optional so a per-source override can set just one. */
const scopeShape = {
  departments: z
    .object({ include: stringList, exclude: stringList })
    .partial()
    .optional(),
  titles: z
    .object({ include: stringList, exclude: stringList, patterns: stringList })
    .partial()
    .optional(),
  levels: z
    .object({ include: stringList, exclude: stringList })
    .partial()
    .optional(),
  locations: z
    .object({
      countries: stringList,
      metros: stringList,
      remote_only: z.boolean(),
      exclude: stringList,
    })
    .partial()
    .optional(),
  posted_within_days: z.number().int().positive().optional(),
  max_new_per_source_per_scan: z.number().int().positive().optional(),
};

export const scopeOverrideSchema = z.object(scopeShape).strict();

export type ScopeOverride = z.infer<typeof scopeOverrideSchema>;

export const scopeSchema = z.object(scopeShape).strict().default({});

export type ScopeConfig = z.infer<typeof scopeSchema>;

const baseSourceSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  company: z.string().min(1),
  /** Per-source override of the global capture mode. */
  capture_mode: captureModeSchema.optional(),
  /** Per-source scope overrides, merged over the global scope. */
  scope: scopeOverrideSchema.optional(),
});

export const sourceSchema = z.discriminatedUnion('type', [
  baseSourceSchema.extend({ type: z.literal('greenhouse'), board: z.string().min(1) }),
  baseSourceSchema.extend({ type: z.literal('lever'), site: z.string().min(1) }),
  baseSourceSchema.extend({ type: z.literal('ashby'), board: z.string().min(1) }),
  baseSourceSchema.extend({
    type: z.literal('career-page'),
    url: z.string().url(),
    browser_fallback: z.boolean().default(false),
  }),
]);

export type SourceConfig = z.infer<typeof sourceSchema>;

export const sourcesSchema = z
  .object({
    version: z.number().int().positive().default(1),
    defaults: z
      .object({
        request_delay_ms: z.number().int().min(0).default(1500),
        timeout_ms: z.number().int().positive().default(20_000),
        max_pages: z.number().int().positive().default(5),
        user_agent: z.string().default('roleeye/0.1 (+local career agent)'),
      })
      .default({
        request_delay_ms: 1500,
        timeout_ms: 20_000,
        max_pages: 5,
        user_agent: 'roleeye/0.1 (+local career agent)',
      }),
    sources: z.array(sourceSchema).default([]),
    discovery: z
      .object({
        capture_mode: captureModeSchema.default('scoped'),
        scope: scopeSchema,
        /**
         * Which companies to watch, as a rule rather than a list.
         *
         * A materialised list is a snapshot of the catalog on the day someone
         * pressed save: a company added to the catalog later would never be
         * watched, even though it matches exactly what they asked for. Storing
         * the intent means coverage grows with the catalog, and the only names
         * in this file are the ones the user deliberately singled out.
         */
        companies: z
          .object({
            size: z.array(z.enum(['startup', 'midsize', 'large'])).default([]),
            ownership: z.array(z.enum(['private', 'public'])).default([]),
            sectors: z.array(z.string()).default([]),
            /** Watched whatever the rule says. Format: `type:token`. */
            include: z.array(z.string()).default([]),
            /** Never watched, even when the rule matches. Wins over include. */
            exclude: z.array(z.string()).default([]),
          })
          .strict()
          .default({ size: [], ownership: [], sectors: [], include: [], exclude: [] }),
      })
      .default({
        capture_mode: 'scoped',
        scope: {},
        companies: { size: [], ownership: [], sectors: [], include: [], exclude: [] },
      }),
    /** Superseded by `discovery.scope.titles`; still honoured for existing configs. */
    discovery_filters: z
      .object({
        title_include: z.array(z.string()).default([]),
        title_exclude: z.array(z.string()).default([]),
      })
      .default({ title_include: [], title_exclude: [] }),
    dedupe: z
      .object({
        repost_gap_days: z.number().int().positive().default(21),
      })
      .default({ repost_gap_days: 21 }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.sources.forEach((source, index) => {
      if (seen.has(source.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', index, 'name'],
          message: `duplicate source name: ${source.name}`,
        });
      }
      seen.add(source.name);
    });
  });

export type SourcesConfig = z.infer<typeof sourcesSchema>;

export const syncSchema = z
  .object({
    version: z.number().int().positive().default(1),
    enabled: z.boolean().default(false),
    target: z
      .object({
        host: z.string().default(''),
        user: z.string().default(''),
        import_dir: z.string().default(''),
        ssh_key_env: z.string().default('ROLEEYE_SYNC_SSH_KEY'),
        known_hosts_check: z.boolean().default(true),
      })
      .optional(),
    export: z
      .object({
        default_mode: z.enum(['private', 'public']).default('private'),
        output_dir: z.string().default('./export'),
        include_artifacts: z.boolean().default(false),
        checksum_algorithm: z.string().default('sha256'),
      })
      .default({
        default_mode: 'private',
        output_dir: './export',
        include_artifacts: false,
        checksum_algorithm: 'sha256',
      }),
    public_allow_list: z.record(z.array(z.string())).default({}),
    schedule: z.record(z.string()).default({}),
  })
  .strict();

export type SyncConfig = z.infer<typeof syncSchema>;
