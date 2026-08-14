import type { ArchetypesConfig } from '../config/archetype-schema.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import { requirementsSchema, type ExtractedRequirements } from '../evaluate/schemas.js';
import type { Logger } from '../util/logger.js';
import { archetypesHash, classify } from './archetypes.js';

/**
 * Running the classifier over stored roles.
 *
 * Two things are protected here. A manual assignment is never overwritten,
 * because the user knows something the classifier does not. And the archetype
 * hash is part of the assignment key, so editing an archetype re-opens the
 * question instead of leaving yesterday's answer in place.
 */

export interface AssignmentSummary {
  considered: number;
  assigned: number;
  unassigned: number;
  keptManual: number;
  byArchetype: { archetypeId: string; count: number }[];
  modelCalls: 0;
}

/** The requirements Phase 3b stored, if this role has been evaluated. */
export function storedRequirements(repos: Repositories, jobId: string): ExtractedRequirements | undefined {
  const evaluation = repos.evaluations.latestForJob(jobId);
  if (!evaluation) return undefined;

  const advocate = evaluation.advocate as { requirements?: unknown } | undefined;
  const parsed = requirementsSchema.safeParse(advocate?.requirements);

  return parsed.success ? parsed.data : undefined;
}

export function assignArchetypes(
  repos: Repositories,
  config: ArchetypesConfig,
  jobs: JobRecord[],
  options: { logger?: Logger; force?: boolean } = {},
): AssignmentSummary {
  const hash = archetypesHash(config);
  let assigned = 0;
  let unassigned = 0;
  let keptManual = 0;

  for (const job of jobs) {
    const manual = repos.assignments.manualForJob(job.id);

    if (manual && !options.force) {
      // Re-recorded under the current hash so the correction survives an edit
      // to the archetype file; the user's answer does not expire.
      if (manual.archetypeHash !== hash) {
        repos.assignments.save({
          jobId: job.id,
          archetypeId: manual.archetypeId,
          archetypeHash: hash,
          score: manual.score,
          runnerUpId: undefined,
          runnerUpScore: undefined,
          method: 'manual',
          evidence: manual.evidence,
        });
      }
      keptManual += 1;
      continue;
    }

    const existing = repos.assignments.find(job.id, hash);
    if (existing && !options.force) {
      if (existing.archetypeId) assigned += 1;
      else unassigned += 1;
      continue;
    }

    const result = classify(
      {
        title: job.title,
        descriptionText: job.descriptionText,
        requirements: storedRequirements(repos, job.id),
      },
      config,
    );

    repos.assignments.save({
      jobId: job.id,
      archetypeId: result.archetypeId,
      archetypeHash: hash,
      score: result.score,
      runnerUpId: result.runnerUpId,
      runnerUpScore: result.runnerUpScore,
      method: 'deterministic',
      evidence: result.archetypeId ? result.evidence : [...result.evidence, `unassigned: ${result.reason}`],
    });

    if (result.archetypeId) assigned += 1;
    else unassigned += 1;
  }

  options.logger?.debug('classification complete', { assigned, unassigned, keptManual });

  return {
    considered: jobs.length,
    assigned,
    unassigned,
    keptManual,
    byArchetype: repos.assignments.countsByArchetype(hash),
    // Stated rather than implied: classification costs nothing, and a
    // regression that quietly added a model call would be expensive and silent.
    modelCalls: 0,
  };
}
