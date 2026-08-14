import type { z } from 'zod';
import type { AppConfig } from '../config/load.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import type { EvaluationRecord } from '../db/repositories/evaluations.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { nowIso } from '../util/time.js';
import type { ReasoningProvider } from '../reasoning/provider.js';
import { createCriteriaContext } from './criteria.js';
import { loadCareerProfile, type CareerProfile } from './profile.js';
import { screenJob } from './screen.js';
import { BudgetGuard } from './budget.js';
import { penaltyFeaturesFrom, scoreEvaluation, type ScoreResult } from './scoring.js';
import {
  assessmentSchema,
  requirementsSchema,
  skepticSchema,
  type ExtractedRequirements,
  type FitAssessment,
  type SkepticReview,
} from './schemas.js';
import {
  buildAssessmentPrompt,
  buildExtractionPrompt,
  buildSkepticPrompt,
  PROMPT_VERSION,
  stripBoilerplate,
} from './prompts.js';

/**
 * The evaluation pipeline.
 *
 * Order matters and is the whole cost story: screening first (free), cache
 * second (free), then extraction and assessment. A role that fails a hard
 * filter or is blocked for fraud never reaches a model.
 */

export type EvaluateOutcome = 'evaluated' | 'cached' | 'skipped' | 'blocked' | 'budget-exhausted' | 'failed';

export interface EvaluateResult {
  jobId: string;
  outcome: EvaluateOutcome;
  evaluation: EvaluationRecord | undefined;
  detail: string | undefined;
  costUsd: number;
}

export interface EvaluatorOptions {
  config: AppConfig;
  repos: Repositories;
  provider: ReasoningProvider | undefined;
  logger: Logger;
  budget: BudgetGuard;
  profile?: CareerProfile | undefined;
}

export class Evaluator {
  private readonly criteria;
  private readonly profile: CareerProfile;

  constructor(private readonly options: EvaluatorOptions) {
    this.criteria = createCriteriaContext(options.config.criteria);
    this.profile = options.profile ?? loadCareerProfile(options.config.env.paths.profileDir);
  }

  get profileInfo(): CareerProfile {
    return this.profile;
  }

  /** Cache identity: content, profile, criteria, prompts, and model. */
  /**
   * A cached verdict is only reusable if the question was identical.
   *
   * Provider and pass count belong here even though they are not "criteria":
   * a two-pass answer must not be served to a user who has since asked for the
   * adversarial third pass, and the same model name means different things on
   * different providers.
   */
  private cacheKeys(job: JobRecord): { contentHash: string; profileHash: string; criteriaHash: string } {
    const provider = this.options.provider;
    const signature = `${provider?.name ?? 'none'}:${provider?.model ?? 'none'}:${this.options.config.criteria.reasoning.passes}`;

    return {
      contentHash: job.descriptionHash,
      profileHash: this.profile.hash,
      criteriaHash: `${this.criteria.hash}:${PROMPT_VERSION}:${signature}`,
    };
  }

  async evaluate(job: JobRecord, options: { force?: boolean } = {}): Promise<EvaluateResult> {
    const { repos, logger, budget } = this.options;
    const keys = this.cacheKeys(job);

    if (!options.force) {
      const cached = repos.evaluations.findCurrent(job.id, keys);
      if (cached) {
        return { jobId: job.id, outcome: 'cached', evaluation: cached, detail: undefined, costUsd: 0 };
      }
    }

    // Deterministic gates. Free, and they remove most of the corpus.
    const screening = repos.screenings.findCurrent(job.id, this.criteria.hash)
      ?? screenJob(repos, job, this.options.config.criteria, this.criteria.hash, nowIso());

    if (screening.authenticity.blocked) {
      return {
        jobId: job.id,
        outcome: 'blocked',
        evaluation: undefined,
        detail: 'blocked for high fraud risk; no model was called',
        costUsd: 0,
      };
    }

    if (!screening.eligible) {
      return {
        jobId: job.id,
        outcome: 'skipped',
        evaluation: undefined,
        detail: screening.rejections.map((rejection) => `${rejection.rule}: ${rejection.detail}`).join('; '),
        costUsd: 0,
      };
    }

    const verdict = budget.check();
    if (!verdict.allowed) {
      return { jobId: job.id, outcome: 'budget-exhausted', evaluation: undefined, detail: verdict.reason, costUsd: 0 };
    }

    const provider = this.options.provider;
    if (!provider) {
      return {
        jobId: job.id,
        outcome: 'failed',
        evaluation: undefined,
        detail: 'no reasoning provider configured. Set reasoning.provider in config/criteria.yaml.',
        costUsd: 0,
      };
    }

    let spent = 0;

    try {
      const extraction = await this.run(provider, job, 'extract', requirementsSchema, buildExtractionPrompt(job));
      spent += extraction.cost;
      const requirements: ExtractedRequirements = extraction.data;

      if (requirements.embedded_instructions.found) {
        // Reported, never obeyed (architecture.md §40).
        logger.warn('posting contains text aimed at an automated reader', {
          jobId: job.id,
          quote: requirements.embedded_instructions.quote?.slice(0, 120),
        });
      }

      const assessmentRun = await this.run(
        provider,
        job,
        'assess',
        assessmentSchema,
        buildAssessmentPrompt(job, requirements, this.profile.text, this.options.config.criteria),
      );
      spent += assessmentRun.cost;
      const assessment: FitAssessment = assessmentRun.data;

      let skeptic: SkepticReview | undefined;
      if (this.options.config.criteria.reasoning.passes === 3) {
        const skepticRun = await this.run(
          provider,
          job,
          'skeptic',
          skepticSchema,
          buildSkepticPrompt(job, assessment, this.profile.text),
        );
        spent += skepticRun.cost;
        skeptic = skepticRun.data;
      }

      // The score is computed here, not by the model.
      const scoring: ScoreResult = scoreEvaluation({
        assessment,
        skeptic,
        criteria: this.options.config.criteria,
        features: penaltyFeaturesFrom(requirements),
      });

      const snapshots = repos.snapshots.listForJob(job.id);
      const snapshot = snapshots.find((entry) => entry.descriptionHash === job.descriptionHash) ?? snapshots.at(-1);

      const evaluation = repos.evaluations.save({
        jobId: job.id,
        snapshotId: snapshot?.id,
        createdAt: nowIso(),
        decision: scoring.decision,
        score: scoring.score,
        confidence: scoring.confidence,
        headline: assessment.headline,
        ...keys,
        assessment: { requirements, assessment },
        skeptic: skeptic ?? null,
        scoring,
      });

      budget.recordJob(spent);

      return { jobId: job.id, outcome: 'evaluated', evaluation, detail: undefined, costUsd: spent };
    } catch (error) {
      budget.recordCost(spent);
      logger.error('evaluation failed', { jobId: job.id, error: errorMessage(error) });
      return { jobId: job.id, outcome: 'failed', evaluation: undefined, detail: errorMessage(error), costUsd: spent };
    }
  }

  /** One model call, recorded whether it succeeds or not. */
  private async run<T>(
    provider: ReasoningProvider,
    job: JobRecord,
    stage: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    bundle: { system: string; prompt: string },
  ): Promise<{ data: T; cost: number }> {
    const started = nowIso();

    try {
      const envelope = await provider.generate<T>({
        stage,
        system: bundle.system,
        prompt: bundle.prompt,
        schema,
        schemaName: stage,
        maxOutputTokens: this.options.config.criteria.reasoning.max_output_tokens,
      });

      this.options.repos.llmCalls.record({
        jobId: job.id,
        evaluationId: undefined,
        stage,
        provider: envelope.provider,
        model: envelope.model,
        inputTokens: envelope.usage.inputTokens,
        outputTokens: envelope.usage.outputTokens,
        estimatedCostUsd: envelope.usage.estimatedCostUsd,
        requestCount: envelope.usage.requestCount,
        cacheHit: false,
        succeeded: true,
        error: undefined,
        createdAt: started,
      });

      return { data: envelope.data as T, cost: envelope.usage.estimatedCostUsd ?? 0 };    } catch (error) {
      // A failed attempt still consumed tokens at the provider.
      this.options.repos.llmCalls.record({
        jobId: job.id,
        evaluationId: undefined,
        stage,
        provider: provider.name,
        model: provider.model,
        inputTokens: undefined,
        outputTokens: undefined,
        estimatedCostUsd: undefined,
        requestCount: 1,
        cacheHit: false,
        succeeded: false,
        error: errorMessage(error),
        createdAt: started,
      });

      throw error;
    }
  }

  /** What would be sent, without sending it. */
  describeRequest(job: JobRecord): { stage: string; system: string; prompt: string; estimatedTokens: number }[] {
    const extraction = buildExtractionPrompt(job);
    const requirements = {
      primary_mission: '(not yet extracted)',
      seniority: '',
      management_scope: 'unclear',
      hands_on_expectation: 'unclear',
      customer_contact: 'unclear',
      ai_role: 'unclear',
      required_skills: [],
      preferred_skills: [],
      domain: [],
      risks_to_verify: [],
      embedded_instructions: { found: false },
    } as ExtractedRequirements;

    const assessment = buildAssessmentPrompt(job, requirements, this.profile.text, this.options.config.criteria);

    const estimate = (bundle: { system: string; prompt: string }): number =>
      Math.round((bundle.system.length + bundle.prompt.length) / 4);

    return [
      { stage: 'extract', ...extraction, estimatedTokens: estimate(extraction) },
      { stage: 'assess', ...assessment, estimatedTokens: estimate(assessment) },
    ];
  }

  /** Tokens saved by stripping boilerplate, for the dry run report. */
  static boilerplateSavings(job: JobRecord): { before: number; after: number } {
    return {
      before: Math.round(job.descriptionText.length / 4),
      after: Math.round(stripBoilerplate(job.descriptionText).length / 4),
    };
  }
}
