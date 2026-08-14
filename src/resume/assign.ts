import type { ArchetypesConfig } from '../config/archetype-schema.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import type { ArchetypeAssignment } from '../db/repositories/resumes.js';
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
 *
 * Everything is read in a fixed number of queries and written in one
 * transaction. Per-job lookups cost roughly six statements per role — 601 for
 * 100 jobs — which is a scan-sized price for a loop over data we already hold.
 */

export interface AssignmentSummary {
  considered: number;
  assigned: number;
  unassigned: number;
  keptManual: number;
  byArchetype: { archetypeId: string; count: number }[];
  modelCalls: 0;
}

function parseRequirements(advocate: unknown): ExtractedRequirements | undefined {
  const parsed = requirementsSchema.safeParse((advocate as { requirements?: unknown } | undefined)?.requirements);
  return parsed.success ? parsed.data : undefined;
}

/** The requirements Phase 3b stored, if this role has been evaluated. */
export function storedRequirements(repos: Repositories, jobId: string): ExtractedRequirements | undefined {
  const evaluation = repos.evaluations.latestForJob(jobId);
  return evaluation ? parseRequirements(evaluation.advocate) : undefined;
}

export function assignArchetypes(
  repos: Repositories,
  config: ArchetypesConfig,
  jobs: JobRecord[],
  options: { logger?: Logger; force?: boolean } = {},
): AssignmentSummary {
  const hash = archetypesHash(config);
  const jobIds = jobs.map((job) => job.id);

  const { manual, current } = repos.assignments.loadForJobs(jobIds, hash);
  const evaluations = repos.evaluations.latestForJobs(jobIds);

  // A forced run is the user saying "decide this again", which has to include
  // the corrections they made earlier. Leaving those live meant the next
  // ordinary run copied them straight back over the new answer.
  if (options.force && manual.size > 0) {
    repos.assignments.supersedeManual([...manual.keys()]);
    manual.clear();
  }

  const pending: Array<Omit<ArchetypeAssignment, 'id' | 'assignedAt'>> = [];
  let assigned = 0;
  let unassigned = 0;
  let keptManual = 0;

  for (const job of jobs) {
    const correction = manual.get(job.id);

    if (correction) {
      // Re-recorded under the current hash so the correction survives an edit
      // to the archetype file; the user's answer does not expire.
      if (correction.archetypeHash !== hash) {
        pending.push({
          jobId: job.id,
          archetypeId: correction.archetypeId,
          archetypeHash: hash,
          score: correction.score,
          runnerUpId: undefined,
          runnerUpScore: undefined,
          method: 'manual',
          evidence: correction.evidence,
        });
      }
      keptManual += 1;
      continue;
    }

    const existing = current.get(job.id);
    if (existing && !options.force) {
      if (existing.archetypeId) assigned += 1;
      else unassigned += 1;
      continue;
    }

    const result = classify(
      {
        title: job.title,
        descriptionText: job.descriptionText,
        requirements: parseRequirements(evaluations.get(job.id)?.advocate),
      },
      config,
    );

    pending.push({
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

  repos.assignments.saveAll(pending);

  options.logger?.debug('classification complete', { assigned, unassigned, keptManual, written: pending.length });

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
