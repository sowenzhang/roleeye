import type { ApplicationStatus, EvaluationDecision } from '../core/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Application } from '../db/repositories/applications.js';
import type { JobRecord } from '../db/repositories/jobs.js';

/**
 * Recording what the user actually did.
 *
 * This is the phase that closes the loop. Until now the product could say
 * "apply to this" and never learn whether the user did, what happened, or
 * whether the advice was any good. Two things therefore happen on every
 * decision: the application is recorded, and the *disagreement or agreement*
 * with the recommendation is recorded beside it.
 *
 * The feedback rows are written now and read in phase 8. A learning loop can
 * only learn from data collected before it existed.
 */

export const ACTIVE_STATUSES: readonly ApplicationStatus[] = [
  'APPLIED',
  'RECRUITER_SCREEN',
  'INTERVIEWING',
  'FINAL',
  'OFFER',
];

export interface RecordOptions {
  status?: ApplicationStatus;
  url?: string | undefined;
  referral?: string | undefined;
  source?: string | undefined;
  note?: string | undefined;
  reason?: string | undefined;
  appliedAt?: string;
}

export interface RecordResult {
  application: Application;
  /** What the system had advised, for the message shown back to the user. */
  advice: { decision: EvaluationDecision | undefined; score: number | undefined };
  overrode: boolean;
}

/**
 * Records an application against a role, with the resume that went with it.
 *
 * The archetype resume and any per-application delta are attached
 * automatically, because a reply six weeks later is only informative if the
 * document that earned it can still be identified.
 */
export function recordApplication(repos: Repositories, job: JobRecord, options: RecordOptions = {}): RecordResult {
  const evaluation = repos.evaluations.latestForJob(job.id);
  const assignment = repos.assignments.latestForJob(job.id);
  const archetypeId = assignment?.archetypeId;
  const generation = archetypeId ? repos.resumes.current(archetypeId) : undefined;

  const delta = repos.artifacts
    .listForJob(job.id)
    .find((artifact) => artifact.type === 'resume-delta');

  // The URL lives on the posting, not the role: one logical role can be
  // advertised in several places, and the user applied through one of them.
  const posting = repos.postings.listForJob(job.id).find((entry) => entry.applyUrl ?? entry.canonicalUrl ?? entry.sourceUrl);

  const application = repos.applications.record({
    jobId: job.id,
    status: options.status ?? 'APPLIED',
    ...(options.appliedAt ? { appliedAt: options.appliedAt } : {}),
    archetypeId,
    generationId: generation?.id,
    resumeArtifactId: delta?.id,
    applicationUrl: options.url ?? posting?.applyUrl ?? posting?.canonicalUrl ?? posting?.sourceUrl,
    referral: options.referral,
    source: options.source,
    evaluationId: evaluation?.id,
    decisionAtApply: evaluation?.decision,
    scoreAtApply: evaluation?.score,
    note: options.note,
  });

  // Applying to something the system discouraged is the most informative event
  // this product can observe, so it is recorded as such rather than as a note.
  const overrode = evaluation !== undefined && evaluation.decision !== 'APPLY';

  repos.applications.recordFeedback({
    jobId: job.id,
    evaluationId: evaluation?.id,
    kind: overrode ? 'applied_despite_advice' : 'agreed',
    decision: evaluation?.decision,
    score: evaluation?.score,
    reason: options.reason,
  });

  return {
    application,
    advice: { decision: evaluation?.decision, score: evaluation?.score },
    overrode,
  };
}

/**
 * Records a decision *not* to apply.
 *
 * Kept deliberately: a role the user passes over after the system recommended
 * it is exactly as informative as one they applied to against advice, and it
 * is the half most tools throw away.
 */
export function skipRole(
  repos: Repositories,
  job: JobRecord,
  options: { reason?: string | undefined } = {},
): { overrode: boolean; decision: EvaluationDecision | undefined } {
  const evaluation = repos.evaluations.latestForJob(job.id);
  const overrode = evaluation?.decision === 'APPLY';

  repos.applications.recordFeedback({
    jobId: job.id,
    evaluationId: evaluation?.id,
    kind: overrode ? 'skipped_despite_advice' : 'agreed',
    decision: evaluation?.decision,
    score: evaluation?.score,
    reason: options.reason,
  });

  return { overrode, decision: evaluation?.decision };
}

export function addNote(
  repos: Repositories,
  job: JobRecord,
  text: string,
  kind = 'note',
): { id: string } {
  const application = repos.applications.findByJob(job.id);

  return repos.notes.add({
    jobId: job.id,
    applicationId: application?.id,
    companyId: job.companyId,
    kind,
    text,
  });
}

export interface PipelineSummary {
  open: number;
  byStatus: { status: ApplicationStatus; count: number }[];
  overrides: { kind: string; count: number }[];
  /** Roles recommended but neither applied to nor explicitly skipped. */
  awaitingDecision: number;
}

export function pipelineSummary(repos: Repositories): PipelineSummary {
  const applications = repos.applications.list({ limit: 500 });
  const decided = new Set(applications.map((application) => application.jobId));

  for (const feedback of repos.applications.feedbackSummary()) void feedback;

  const recommended = repos.evaluations.listRecommendations(200, ['APPLY']);
  const awaiting = recommended.filter((evaluation) => {
    if (decided.has(evaluation.jobId)) return false;
    return repos.applications.feedbackForJob(evaluation.jobId).length === 0;
  });

  return {
    open: applications.filter((application) => application.closedAt === undefined).length,
    byStatus: repos.applications.countsByStatus(),
    overrides: repos.applications.feedbackSummary().filter((entry) => entry.kind !== 'agreed'),
    awaitingDecision: awaiting.length,
  };
}
