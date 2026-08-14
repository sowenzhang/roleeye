import { z } from 'zod';
import { budgetSchema, screeningSchema, unknownHandlingSchema } from './screening-schema.js';
import { reasoningSchema } from './reasoning-schema.js';

const weightSchema = z.number().int().min(0).max(100);

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
      })
      .default({ capture_mode: 'scoped', scope: {} }),
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
