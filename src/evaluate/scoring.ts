import type { CriteriaConfig } from '../config/schema.js';
import type { EvaluationDecision } from '../core/types.js';
import { CATEGORY_KEYS, type CategoryKey, type FitAssessment, type SkepticReview } from './schemas.js';

/**
 * Deterministic scoring.
 *
 * The model supplies per-category judgements with evidence; the score is
 * computed here from the user's own weights. That keeps the number
 * reproducible, explainable, and adjustable without re-running any model —
 * change a weight and every stored assessment can be rescored for free.
 *
 * It also honours the project rule that the LLM reasons and deterministic code
 * calculates.
 */

export interface CategoryBreakdown {
  category: CategoryKey;
  weight: number;
  rawScore: number;
  adjustment: number;
  finalScore: number;
  weightedPoints: number;
  confidence: number;
  evidence: string;
}

export interface PenaltyApplied {
  rule: string;
  points: number;
  reason: string;
}

export interface ScoreResult {
  score: number;
  decision: EvaluationDecision;
  confidence: number;
  breakdown: CategoryBreakdown[];
  penalties: PenaltyApplied[];
  /** Weighted score before penalties, so the effect of each is visible. */
  baseScore: number;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Penalties the user configured, applied to structural facts rather than to
 * the model's mood. Each one names itself in the result.
 */
function computePenalties(criteria: CriteriaConfig, features: PenaltyFeatures): PenaltyApplied[] {
  const applied: PenaltyApplied[] = [];

  const value = (key: string): number | undefined => {
    const entry = criteria.penalties[key];
    return typeof entry === 'number' ? entry : undefined;
  };

  const management = value('primarily_people_management');
  if (management !== undefined && (features.managementScope === 'multiple_teams' || features.managementScope === 'org')) {
    applied.push({
      rule: 'primarily_people_management',
      points: management,
      reason: `the posting describes managing ${features.managementScope.replace('_', ' ')}`,
    });
  }

  const infrastructure = value('infrastructure_primary');
  if (infrastructure !== undefined && features.infrastructurePrimary) {
    applied.push({
      rule: 'infrastructure_primary',
      points: infrastructure,
      reason: 'the role is primarily infrastructure work',
    });
  }

  return applied;
}

export interface PenaltyFeatures {
  managementScope: string;
  infrastructurePrimary: boolean;
}

export interface ScoreInput {
  assessment: FitAssessment;
  skeptic?: SkepticReview | undefined;
  criteria: CriteriaConfig;
  features: PenaltyFeatures;
}

export function scoreEvaluation(input: ScoreInput): ScoreResult {
  const { assessment, skeptic, criteria } = input;
  const weights = criteria.weights as Record<CategoryKey, number>;

  const adjustments = new Map<CategoryKey, number>();
  for (const adjustment of skeptic?.adjustments ?? []) {
    adjustments.set(adjustment.category, (adjustments.get(adjustment.category) ?? 0) + adjustment.delta);
  }

  const totalWeight = CATEGORY_KEYS.reduce((sum, key) => sum + (weights[key] ?? 0), 0) || 100;

  const breakdown: CategoryBreakdown[] = CATEGORY_KEYS.map((category) => {
    const assessed = assessment.categories[category];
    const weight = weights[category] ?? 0;
    const adjustment = adjustments.get(category) ?? 0;
    const finalScore = clamp(assessed.score + adjustment);

    return {
      category,
      weight,
      rawScore: assessed.score,
      adjustment,
      finalScore,
      weightedPoints: (finalScore * weight) / totalWeight,
      confidence: assessed.confidence,
      evidence: assessed.evidence,
    };
  });

  const baseScore = breakdown.reduce((sum, entry) => sum + entry.weightedPoints, 0);
  const penalties = computePenalties(criteria, input.features);
  const penaltyPoints = penalties.reduce((sum, penalty) => sum + penalty.points, 0);
  const score = Math.round(clamp(baseScore + penaltyPoints));

  // Weighted mean confidence: a category the user cares about matters more.
  const confidence =
    breakdown.reduce((sum, entry) => sum + entry.confidence * entry.weight, 0) / totalWeight;

  const thresholds = criteria.decision_thresholds;
  const decision: EvaluationDecision =
    score >= thresholds.apply ? 'APPLY' : score >= thresholds.maybe ? 'MAYBE' : 'SKIP';

  return {
    score,
    decision,
    confidence: Number(confidence.toFixed(2)),
    breakdown,
    penalties,
    baseScore: Math.round(baseScore),
  };
}

/** Infers the structural facts penalties key off, from extracted requirements. */
export function penaltyFeaturesFrom(requirements: {
  management_scope: string;
  domain: string[];
  primary_mission: string;
}): PenaltyFeatures {
  const haystack = `${requirements.primary_mission} ${requirements.domain.join(' ')}`.toLowerCase();
  const infrastructureTerms = ['infrastructure', 'platform reliability', 'kubernetes', 'sre', 'devops'];
  const productTerms = ['product', 'customer', 'user-facing', 'application'];

  const infraHits = infrastructureTerms.filter((term) => haystack.includes(term)).length;
  const productHits = productTerms.filter((term) => haystack.includes(term)).length;

  return {
    managementScope: requirements.management_scope,
    infrastructurePrimary: infraHits > 0 && infraHits > productHits,
  };
}
