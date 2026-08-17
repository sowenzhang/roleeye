import type { AppConfig } from '../config/load.js';
import type { Database } from '../db/database.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../util/logger.js';
import { errorMessage } from '../util/errors.js';
import {
  isPipelineStage,
  PIPELINE_STAGES,
  runPipeline,
  type PipelineEvent,
  type PipelineResult,
  type PipelineStage,
} from '../core/pipeline.js';
import { describeLock, readRunLock } from '../core/run-lock.js';

/**
 * One run at a time, and its progress.
 *
 * The portal could configure a pipeline it could not start, so the only way to
 * use RoleEye was to leave the browser and type three commands in the right
 * order. This holds the state of a run so the page can show what is happening
 * while it happens.
 *
 * State lives in memory rather than the database on purpose. It is the progress
 * of a process, so it is meaningless once that process is gone — persisting it
 * would mean a page could show "scanning" for a run that died with the terminal.
 * What the run *produced* is already durable: scans, source runs, screenings and
 * evaluations are all written by the stages themselves.
 *
 * Progress is polled rather than pushed. An `EventSource` cannot set a header,
 * so it could not carry the portal token, and reconnect logic is more code than
 * a one-second poll of an in-memory object is worth.
 */

/** Bounded: a long evaluate run emits an entry per role, and the page renders all of them. */
const MAX_LOG = 300;

export interface RunLogEntry {
  at: string;
  stage: PipelineStage;
  kind: PipelineEvent['kind'];
  message: string;
}

export interface StageState {
  stage: PipelineStage;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  done: number;
  total: number | undefined;
  message: string;
}

export interface RunState {
  running: boolean;
  runId: string | undefined;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  status: 'idle' | 'running' | 'ok' | 'warning' | 'failed' | 'cancelled' | 'error' | 'busy';
  /** Set when the run could not start at all, such as unreadable configuration. */
  error: string | undefined;
  cancelRequested: boolean;
  stages: StageState[];
  log: RunLogEntry[];
  result: PipelineResult | undefined;
}

export interface RunServiceDependencies {
  logger: Logger;
  /** Read fresh and strictly, so a run never uses settings the user has since changed. */
  loadConfig: () => AppConfig;
  openDb: () => { db: Database; repos: Repositories };
}

export interface StartRunRequest {
  stages?: unknown;
  limit?: unknown;
  force?: unknown;
  only?: unknown;
}

export function parseStages(value: unknown): PipelineStage[] {
  if (!Array.isArray(value)) return [...PIPELINE_STAGES];

  const wanted = new Set(value.filter(isPipelineStage));
  // Fixed order: screening roles that have not been fetched, or assessing roles
  // that have not been screened, is a run that silently does nothing.
  const ordered = PIPELINE_STAGES.filter((stage) => wanted.has(stage));

  return ordered.length > 0 ? [...ordered] : [...PIPELINE_STAGES];
}

export class RunService {
  private state: RunState = idleState();
  private controller: AbortController | undefined;
  private active: Promise<void> | undefined;

  constructor(private readonly deps: RunServiceDependencies) {}

  snapshot(): RunState {
    // A copy: the page's view must not be a live reference into a mutating run.
    return {
      ...this.state,
      stages: this.state.stages.map((stage) => ({ ...stage })),
      log: [...this.state.log],
    };
  }

  get isRunning(): boolean {
    return this.state.running;
  }

  /**
   * Starts a run, or refuses because one is already going.
   *
   * Refusing is the whole point. Two concurrent scans would write to the same
   * SQLite file through the same connection and interleave their source runs,
   * and two evaluate stages would spend the daily budget twice.
   */
  start(request: StartRunRequest): { started: boolean; reason?: string; state: RunState } {
    if (this.state.running) {
      return { started: false, reason: 'A run is already in progress.', state: this.snapshot() };
    }

    // The in-memory flag above only knows about this process. The scheduled
    // task and any terminal are separate processes, and the lock is what makes
    // "one run at a time" true across all of them. Checked here so the page can
    // refuse with a useful message rather than starting something that dies a
    // moment later; the atomic claim inside the pipeline still decides.
    const foreign = this.foreignRun();
    if (foreign) return { started: false, reason: foreign, state: this.snapshot() };

    const stages = parseStages(request.stages);
    const limit =
      typeof request.limit === 'number' && Number.isFinite(request.limit)
        ? Math.min(Math.max(Math.trunc(request.limit), 0), 500)
        : undefined;
    const force = request.force === true;
    const only =
      Array.isArray(request.only) && request.only.every((entry) => typeof entry === 'string')
        ? (request.only as string[])
        : undefined;

    const runId = `run_${Date.now().toString(16)}`;
    const controller = new AbortController();
    this.controller = controller;

    this.state = {
      running: true,
      runId,
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      status: 'running',
      error: undefined,
      cancelRequested: false,
      stages: stages.map((stage) => ({
        stage,
        status: 'pending',
        done: 0,
        total: undefined,
        message: '',
      })),
      log: [],
      result: undefined,
    };

    this.active = this.execute({ stages, limit, force, only, signal: controller.signal }).catch(() => {
      // `execute` records its own failure; this only stops an unhandled rejection.
    });

    return { started: true, state: this.snapshot() };
  }

  /**
   * Asks the run to stop at the next safe boundary.
   *
   * It is a request, not a kill: a source mid-fetch and a role mid-assessment
   * both finish, because abandoning them would leave a run row open and waste
   * a call the user has already paid for.
   */
  cancel(): { cancelling: boolean; reason?: string } {
    if (!this.state.running || !this.controller) return { cancelling: false, reason: 'Nothing is running.' };

    this.state.cancelRequested = true;
    this.controller.abort();
    this.append({
      kind: 'progress',
      stage: this.currentStage() ?? 'scan',
      at: new Date().toISOString(),
      message: 'Stopping after the current step finishes.',
      done: 0,
      total: undefined,
    });

    return { cancelling: true };
  }

  /** Lets a shutting-down portal wait for committed work rather than abandoning it. */
  async settle(): Promise<void> {
    await this.active;
  }

  private currentStage(): PipelineStage | undefined {
    return this.state.stages.find((stage) => stage.status === 'running')?.stage;
  }

  /** A run held by another process, described, or nothing. */
  private foreignRun(): string | undefined {
    try {
      const held = readRunLock(this.deps.openDb().db);
      return held ? describeLock(held) : undefined;
    } catch {
      // An unopenable database will fail the run itself with a better message
      // than this one could give.
      return undefined;
    }
  }

  private async execute(options: {
    stages: PipelineStage[];
    limit: number | undefined;
    force: boolean;
    only: string[] | undefined;
    signal: AbortSignal;
  }): Promise<void> {
    const { logger } = this.deps;

    try {
      // Loaded here, not at portal start: the user may have changed everything
      // in the panel above the button they just pressed.
      const config = this.deps.loadConfig();
      const { db, repos } = this.deps.openDb();

      const result = await runPipeline({
        config,
        db,
        repos,
        logger,
        stages: options.stages,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.force ? { force: true } : {}),
        ...(options.only ? { only: options.only } : {}),
        signal: options.signal,
        onEvent: (event) => this.append(event),
        kind: 'portal',
      });

      this.state.result = result;
      this.state.status = result.status;

      // The pipeline emits nothing when it loses the race for the lock, so the
      // page would otherwise show a finished run with an empty log.
      if (result.status === 'busy') {
        const reason = result.errors[0]?.message ?? 'Another RoleEye run is in progress.';
        this.state.error = reason;
        this.state.log.push({
          at: new Date().toISOString(),
          stage: options.stages[0] ?? 'scan',
          kind: 'stage-skipped',
          message: reason,
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      this.state.status = 'error';
      this.state.error = message;
      logger.error('run failed to start', { error: message });

      // Nothing ever started, so no stage reported anything. Blaming the first
      // one is the truth: that is where the run died, and marking every stage
      // "skipped" reads as a run that decided there was nothing to do.
      const first = this.state.stages[0];
      if (first) {
        first.status = 'failed';
        first.message = message;
      }

      this.state.log.push({
        at: new Date().toISOString(),
        stage: options.stages[0] ?? 'scan',
        kind: 'stage-failed',
        message,
      });
    } finally {
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
      this.controller = undefined;

      // Anything still marked running lost its stage-done to a failure above.
      for (const stage of this.state.stages) {
        if (stage.status === 'running') stage.status = this.state.status === 'cancelled' ? 'done' : 'failed';
        else if (stage.status === 'pending') stage.status = 'skipped';
      }
    }
  }

  private append(event: PipelineEvent): void {
    const stage = this.state.stages.find((entry) => entry.stage === event.stage);

    if (stage) {
      if (event.kind === 'stage-start') stage.status = 'running';
      else if (event.kind === 'stage-done') stage.status = 'done';
      else if (event.kind === 'stage-failed') stage.status = 'failed';
      else if (event.kind === 'stage-skipped') stage.status = 'skipped';

      if (event.kind === 'progress') {
        stage.done = event.done;
        stage.total = event.total;
      }
      stage.message = event.message;
    }

    this.state.log.push({ at: event.at, stage: event.stage, kind: event.kind, message: event.message });
    if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
  }
}

function idleState(): RunState {
  return {
    running: false,
    runId: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    status: 'idle',
    error: undefined,
    cancelRequested: false,
    stages: [],
    log: [],
    result: undefined,
  };
}
