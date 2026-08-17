import type { AppConfig } from '../config/load.js';
import type { Database } from '../db/database.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import type { Logger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';
import { PIPELINE_STAGES, rankEligible } from '../core/pipeline.js';
import { compileWeights, IMPORTANCE_LABELS, inferImportance, type WeightKey } from '../config/schema.js';
import { Evaluator } from '../evaluate/evaluator.js';
import { BudgetGuard } from '../evaluate/budget.js';
import { describeProvider, isLocalProvider } from '../reasoning/registry.js';
import { checkBuild, installSchedule, readSchedule, removeSchedule } from '../schedule/inspect.js';
import { TASK_NAME } from '../schedule/os-scheduler.js';
import type { ConfigService } from './config-service.js';
import type { RunService } from './run-service.js';
import type { RouteHandler, RouteResult } from './server.js';

/**
 * Running, scheduling, and seeing the question before it is asked.
 *
 * These three were the portal's missing half. It could describe a pipeline in
 * detail and then had to tell the user to go and type three commands; it
 * mentioned "the scheduled run" without being able to say whether one existed;
 * and it spent the user's money on a prompt they had never been shown.
 */

export interface RunRouteDependencies {
  logger: Logger;
  runs: RunService;
  config: ConfigService;
  /** Fresh and strict, so what is previewed is what would be sent. */
  loadConfig: () => AppConfig;
  openDb: () => { db: Database; repos: Repositories };
  /** Absolute project root, for building the scheduler's command line. */
  root: string;
}

function ok(json: unknown): RouteResult {
  return { status: 200, json };
}

function badRequest(json: unknown): RouteResult {
  return { status: 400, json };
}

function conflict(json: unknown): RouteResult {
  return { status: 409, json };
}

/**
 * The role a preview should use.
 *
 * The highest-priority eligible one, because that is the role the next run
 * would actually spend money on — previewing an arbitrary posting would show a
 * prompt that is structurally right and substantively about something else.
 */
function previewJob(repos: Repositories, config: AppConfig, requested: string | null): JobRecord | undefined {
  if (requested) {
    const exact = repos.jobs.findById(requested);
    if (exact) return exact;
  }

  const ranked = rankEligible(repos, config);
  return ranked[0]?.job ?? repos.jobs.list({ inScope: true, limit: 1 })[0];
}

export function createRunRoutes(deps: RunRouteDependencies): Record<string, RouteHandler> {
  return {
    'GET /api/run': () => ok(deps.runs.snapshot()),

    /**
     * Starts the daily sequence.
     *
     * The stages are named by the caller but ordered here, and a second request
     * while one is in flight is refused rather than queued: two runs would
     * interleave source runs in one SQLite connection and spend the daily
     * budget twice.
     */
    'POST /api/run': ({ body }) => {
      const payload = (body ?? {}) as Record<string, unknown>;
      const result = deps.runs.start(payload);

      if (!result.started) return conflict({ started: false, reason: result.reason, state: result.state });
      return ok({ started: true, state: result.state });
    },

    'POST /api/run/cancel': () => {
      const result = deps.runs.cancel();
      return ok({ ...result, state: deps.runs.snapshot() });
    },

    'GET /api/run/options': () => {
      const criteria = deps.config.readCriteria().value as Record<string, any>;
      const reasoning = criteria['reasoning'] ?? {};
      const sources = deps.config.readSources().value;

      return ok({
        stages: PIPELINE_STAGES,
        enabledSources: sources.sources.filter((source) => source.enabled).length,
        defaultLimit: criteria['budget']?.max_jobs_per_scan ?? 5,
        provider: reasoning.provider ?? 'none',
        // Measured: an agent CLI takes minutes per role, an API a few seconds.
        minutesPerRole:
          reasoning.provider === 'none'
            ? undefined
            : (reasoning.provider === 'agent-cli' ? 3.5 : 0.1) * (reasoning.passes ?? 2),
      });
    },

    /**
     * What is scheduled, and when it next fires.
     *
     * The portal used to say "wait for the scheduled run" without being able to
     * confirm that one existed. Reporting nothing scheduled is the useful half
     * of this endpoint.
     */
    'GET /api/schedule': () => {
      const build = checkBuild(deps.root);

      try {
        return ok({ ...readSchedule(TASK_NAME), build });
      } catch (error) {
        return ok({
          scheduler: process.platform === 'win32' ? 'windows' : 'cron',
          taskName: TASK_NAME,
          installed: false,
          build,
          error: errorMessage(error),
        });
      }
    },

    /** Installs or removes the daily run, through the same module the CLI uses. */
    'POST /api/schedule': ({ body }) => {
      const payload = (body ?? {}) as { action?: unknown; at?: unknown; command?: unknown };
      const action = payload.action === 'install' || payload.action === 'remove' ? payload.action : undefined;
      if (!action) return badRequest({ ok: false, reason: 'action must be install or remove' });

      try {
        if (action === 'remove') {
          const result = removeSchedule(TASK_NAME);
          return ok({ ok: true, action, ...result, schedule: { ...readSchedule(TASK_NAME), build: checkBuild(deps.root) } });
        }

        const at = typeof payload.at === 'string' ? payload.at : '07:30';
        // Only the stages RoleEye itself defines may be scheduled: this string
        // becomes an argument in a command line the operating system will run.
        const command =
          typeof payload.command === 'string' && /^[a-z]+$/.test(payload.command) ? payload.command : 'run';

        const schedule = installSchedule({
          time: at,
          command,
          root: deps.root,
          nodePath: process.execPath,
          taskName: TASK_NAME,
        });

        return ok({ ok: true, action, schedule: { ...schedule, build: checkBuild(deps.root) } });
      } catch (error) {
        return badRequest({ ok: false, reason: errorMessage(error) });
      }
    },

    /**
     * The exact prompts, and the parts of them the user owns.
     *
     * Two different things are on this page and they must not be confused. The
     * templates are shown read-only: the fence that separates instructions from
     * attacker-written posting text is a security control, and a user cannot be
     * asked to maintain it correctly. What they can edit is what the prompt says
     * about *them* — the direction they want, what each category is worth, and
     * where the thresholds sit. Those are inputs, and they are interpolated into
     * clearly marked places above the fence.
     */
    'GET /api/prompt': ({ query }) => {
      const criteria = deps.config.readCriteria().value as Record<string, any>;

      // Building the prompts means reading a posting and a profile off disk and
      // constructing an Evaluator. The Run view needs the guidance to draw its
      // sliders on every visit; it needs the prompts only when someone opens
      // the panel, which most visits never do.
      if (query.get('guidance') === 'only') {
        return ok({ previewAvailable: false, guidanceOnly: true, guidance: guidanceOf(criteria) });
      }

      let config: AppConfig;
      try {
        config = deps.loadConfig();
      } catch (error) {
        return ok({
          previewAvailable: false,
          reason: errorMessage(error),
          guidance: guidanceOf(criteria),
        });
      }

      const { repos } = deps.openDb();
      const job = previewJob(repos, config, query.get('jobId'));

      if (!job) {
        return ok({
          previewAvailable: false,
          reason: 'Nothing has been fetched yet, so there is no posting to preview a prompt against. Run a scan first.',
          guidance: guidanceOf(criteria),
          provider: describeProvider(config.criteria.reasoning),
          local: isLocalProvider(config.criteria.reasoning),
        });
      }

      const budget = new BudgetGuard(config.criteria.budget, BudgetGuard.monthToDateCost(repos.llmCalls));
      const evaluator = new Evaluator({ config, repos, provider: undefined, logger: deps.logger, budget });

      const requests = evaluator.describeRequest(job);
      const savings = Evaluator.boilerplateSavings(job);
      const reasoning = config.criteria.reasoning;
      const inputTokens = requests.reduce((sum, request) => sum + request.estimatedTokens, 0);
      const outputTokens = reasoning.max_output_tokens * requests.length;
      const cost =
        (inputTokens / 1_000_000) * reasoning.pricing.input_per_mtok +
        (outputTokens / 1_000_000) * reasoning.pricing.output_per_mtok;

      return ok({
        previewAvailable: true,
        job: { id: job.id, company: job.companyName, title: job.title },
        provider: describeProvider(reasoning),
        local: isLocalProvider(reasoning),
        passes: reasoning.passes,
        profile: { exists: evaluator.profileInfo.exists, redactions: evaluator.profileInfo.redactions },
        boilerplate: savings,
        estimate: {
          inputTokens,
          outputTokens,
          costUsd: Number(cost.toFixed(6)),
        },
        // The prompt is long third-party-bearing text, but it is the user's own
        // machine talking about their own posting; it is bounded, not trimmed to
        // a summary, because a preview that hides the middle is not a preview.
        requests: requests.map((request) => ({
          stage: request.stage,
          system: request.system,
          prompt: request.prompt.slice(0, 20_000),
          truncated: request.prompt.length > 20_000,
          estimatedTokens: request.estimatedTokens,
        })),
        guidance: guidanceOf(criteria),
      });
    },

    /**
     * Saves the parts of the prompt the user owns.
     *
     * Only the four keys named here are written. A body carrying anything else
     * cannot reach the file, so this endpoint can never become a way to rewrite
     * criteria.yaml wholesale.
     */
    'PUT /api/prompt': ({ body }) => {
      const payload = (body ?? {}) as Record<string, unknown>;
      const document = deps.config.readCriteria();

      if (!document.valid) {
        return badRequest({
          saved: false,
          reason: 'criteria.yaml cannot be read, so saving would overwrite settings that are not shown here.',
          problems: document.problems,
        });
      }

      const criteria = document.value as Record<string, any>;

      if (payload['direction'] !== undefined) {
        const direction = payload['direction'];
        // `null` passes an `!== undefined` check and then throws on property
        // access, turning a malformed body into a 500 rather than an answer.
        if (typeof direction !== 'object' || direction === null || Array.isArray(direction)) {
          return badRequest({ saved: false, reason: 'direction must be an object with positive and negative lists' });
        }

        const { positive, negative } = direction as { positive?: unknown; negative?: unknown };
        criteria['preferences'] = {
          ...criteria['preferences'],
          direction: { positive: phrases(positive), negative: phrases(negative) },
        };
      }

      if (payload['importance'] !== undefined) {
        // Written together, always. `weights` is what scoring reads, so an
        // importance saved without recompiling them would be a preference the
        // user can see and the scorer ignores.
        const importance = { ...criteria['importance'], ...(payload['importance'] as Record<string, unknown>) };
        const clean = Object.fromEntries(
          WEIGHT_KEYS.map((key) => [key, clampImportance(importance[key], criteria['weights']?.[key])]),
        ) as Record<WeightKey, number>;

        criteria['importance'] = clean;
        criteria['weights'] = compileWeights(clean);
      } else if (payload['weights'] !== undefined) {
        criteria['weights'] = { ...criteria['weights'], ...(payload['weights'] as Record<string, unknown>) };
      }

      if (payload['decision_thresholds'] !== undefined) {
        criteria['decision_thresholds'] = {
          ...criteria['decision_thresholds'],
          ...(payload['decision_thresholds'] as Record<string, unknown>),
        };
      }

      const result = deps.config.saveCriteria(criteria);
      return result.ok
        ? ok({ saved: true, path: result.path, guidance: guidanceOf(result.value as Record<string, any>) })
        : badRequest({ saved: false, problems: result.problems });
    },
  };
}

/**
 * Free text that goes into a prompt, bounded.
 *
 * These phrases are the user's own words, so they are not fenced as untrusted —
 * but an unbounded list pasted from elsewhere would silently push the posting
 * out of the model's context, which is a correctness problem rather than a
 * security one.
 */
function phrases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.replace(/\s+/g, ' ').trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 20)
    .map((entry) => entry.slice(0, 160));
}

function guidanceOf(criteria: Record<string, any>): unknown {
  const weights = criteria['weights'] ?? {};

  return {
    direction: {
      positive: criteria['preferences']?.direction?.positive ?? [],
      negative: criteria['preferences']?.direction?.negative ?? [],
    },
    weights,
    // A file written before importance existed still has to open on something
    // the user recognises, so it is recovered from the weights they have.
    importance: criteria['importance'] ?? inferImportance(weights),
    importanceLabels: IMPORTANCE_LABELS,
    decision_thresholds: criteria['decision_thresholds'] ?? {},
  };
}

const WEIGHT_KEYS = [
  'career_direction',
  'hands_on',
  'product_customer',
  'ai_relevance',
  'technical_domain',
  'location',
  'compensation',
] as const;

/** A rating outside 0-5 is a client bug, not a reason to write a broken file. */
function clampImportance(value: unknown, fallbackWeight: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(5, Math.trunc(value)));
  }
  return typeof fallbackWeight === 'number' ? Math.max(1, Math.min(5, Math.round(fallbackWeight / 5))) : 3;
}
