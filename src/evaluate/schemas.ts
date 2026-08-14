import { z } from 'zod';

/**
 * Structured outputs the model must produce.
 *
 * Everything crossing the model boundary is validated before it is persisted or
 * scored. The model supplies judgement and evidence; it never supplies the
 * final score, which is computed in code from these fields.
 */

/** The seven categories are exactly the weights in `criteria.yaml`. */
export const CATEGORY_KEYS = [
  'career_direction',
  'hands_on',
  'product_customer',
  'ai_relevance',
  'technical_domain',
  'location',
  'compensation',
] as const;

export type CategoryKey = (typeof CATEGORY_KEYS)[number];

const categoryAssessment = z.object({
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  evidence: z.string().max(400),
});

export const requirementsSchema = z
  .object({
    primary_mission: z.string().max(400),
    seniority: z.string().max(120),
    management_scope: z.enum(['none', 'mentoring', 'small_team', 'multiple_teams', 'org', 'unclear']),
    hands_on_expectation: z.enum(['daily_coding', 'mixed', 'architecture_review', 'non_technical', 'unclear']),
    customer_contact: z.enum(['direct', 'indirect', 'none', 'unclear']),
    ai_role: z.enum(['core', 'supporting', 'roadmap_only', 'none', 'unclear']),
    required_skills: z.array(z.string().max(80)).max(20),
    preferred_skills: z.array(z.string().max(80)).max(20),
    domain: z.array(z.string().max(60)).max(10),
    risks_to_verify: z.array(z.string().max(200)).max(10),
    /**
     * Postings are third-party text. If one contains instructions aimed at an
     * automated reader, that is reported to the user, never obeyed.
     */
    embedded_instructions: z
      .object({
        found: z.boolean(),
        quote: z.string().max(300).optional(),
      })
      .default({ found: false }),
  })
  .strict();

export type ExtractedRequirements = z.infer<typeof requirementsSchema>;

export const assessmentSchema = z
  .object({
    categories: z.object({
      career_direction: categoryAssessment,
      hands_on: categoryAssessment,
      product_customer: categoryAssessment,
      ai_relevance: categoryAssessment,
      technical_domain: categoryAssessment,
      location: categoryAssessment,
      compensation: categoryAssessment,
    }),
    headline: z.string().max(200),
    strengths: z.array(z.string().max(240)).max(6),
    /** The skeptical half: reasons this could be a poor use of time. */
    concerns: z.array(z.string().max(240)).max(8),
    questions_to_verify: z.array(z.string().max(200)).max(8),
    best_resume_angles: z.array(z.string().max(200)).max(6),
    career_direction_fit: z.enum(['strong', 'mixed', 'weak']),
    career_direction_reason: z.string().max(400),
  })
  .strict();

export type FitAssessment = z.infer<typeof assessmentSchema>;

/**
 * The optional third pass.
 *
 * Adjustments are bounded and applied in code, so an adversarial pass can move
 * a score but never replace the scoring rules.
 */
export const skepticSchema = z
  .object({
    challenges: z.array(z.string().max(240)).max(8),
    overlooked_risks: z.array(z.string().max(240)).max(8),
    adjustments: z
      .array(
        z.object({
          category: z.enum(CATEGORY_KEYS),
          delta: z.number().min(-30).max(10),
          reason: z.string().max(240),
        }),
      )
      .max(7),
    additional_questions: z.array(z.string().max(200)).max(6),
  })
  .strict();

export type SkepticReview = z.infer<typeof skepticSchema>;
