import type { ApplicationStatus, EvaluationDecision } from '../../core/types.js';
import { randomId } from '../../util/hash.js';
import { nowIso, type IsoTimestamp } from '../../util/time.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

/**
 * Applications, their history, and where the user disagreed with the advice.
 *
 * The status row is a cache; `application_status_events` is what happened.
 * Nothing here ever rewrites history, because the value of this table is
 * answering "what did I do, and what did it lead to" months later.
 */

export interface Application {
  id: string;
  jobId: string;
  createdAt: IsoTimestamp;
  appliedAt: IsoTimestamp | undefined;
  currentStatus: ApplicationStatus;
  archetypeId: string | undefined;
  generationId: string | undefined;
  resumeArtifactId: string | undefined;
  applicationUrl: string | undefined;
  referral: string | undefined;
  source: string | undefined;
  evaluationId: string | undefined;
  decisionAtApply: EvaluationDecision | undefined;
  scoreAtApply: number | undefined;
  closedAt: IsoTimestamp | undefined;
}

export interface StatusEvent {
  id: string;
  applicationId: string;
  fromStatus: ApplicationStatus | undefined;
  toStatus: ApplicationStatus;
  occurredAt: IsoTimestamp;
  notes: string | undefined;
  source: string;
}

export type FeedbackKind = 'applied_despite_advice' | 'skipped_despite_advice' | 'agreed' | 'corrected';

export interface RoleFeedback {
  id: string;
  jobId: string;
  evaluationId: string | undefined;
  kind: FeedbackKind;
  decision: EvaluationDecision | undefined;
  score: number | undefined;
  reason: string | undefined;
  createdAt: IsoTimestamp;
}

interface ApplicationRow {
  id: string;
  job_id: string;
  created_at: string;
  applied_at: string | null;
  current_status: string;
  archetype_id: string | null;
  generation_id: string | null;
  resume_artifact_id: string | null;
  application_url: string | null;
  referral: string | null;
  source: string | null;
  evaluation_id: string | null;
  decision_at_apply: string | null;
  score_at_apply: number | null;
  closed_at: string | null;
}

interface StatusEventRow {
  id: string;
  application_id: string;
  from_status: string | null;
  to_status: string;
  occurred_at: string;
  notes: string | null;
  source: string;
}

interface FeedbackRow {
  id: string;
  job_id: string;
  evaluation_id: string | null;
  kind: string;
  decision: string | null;
  score: number | null;
  reason: string | null;
  created_at: string;
}

function mapApplication(row: ApplicationRow): Application {
  return {
    id: row.id,
    jobId: row.job_id,
    createdAt: row.created_at,
    appliedAt: fromDb(row.applied_at),
    currentStatus: row.current_status as ApplicationStatus,
    archetypeId: fromDb(row.archetype_id),
    generationId: fromDb(row.generation_id),
    resumeArtifactId: fromDb(row.resume_artifact_id),
    applicationUrl: fromDb(row.application_url),
    referral: fromDb(row.referral),
    source: fromDb(row.source),
    evaluationId: fromDb(row.evaluation_id),
    decisionAtApply: fromDb(row.decision_at_apply) as EvaluationDecision | undefined,
    scoreAtApply: fromDb(row.score_at_apply),
    closedAt: fromDb(row.closed_at),
  };
}

function mapEvent(row: StatusEventRow): StatusEvent {
  return {
    id: row.id,
    applicationId: row.application_id,
    fromStatus: fromDb(row.from_status) as ApplicationStatus | undefined,
    toStatus: row.to_status as ApplicationStatus,
    occurredAt: row.occurred_at,
    notes: fromDb(row.notes),
    source: row.source,
  };
}

function mapFeedback(row: FeedbackRow): RoleFeedback {
  return {
    id: row.id,
    jobId: row.job_id,
    evaluationId: fromDb(row.evaluation_id),
    kind: row.kind as FeedbackKind,
    decision: fromDb(row.decision) as EvaluationDecision | undefined,
    score: fromDb(row.score),
    reason: fromDb(row.reason),
    createdAt: row.created_at,
  };
}

export interface RecordApplicationInput {
  jobId: string;
  appliedAt?: IsoTimestamp;
  status?: ApplicationStatus;
  archetypeId?: string | undefined;
  generationId?: string | undefined;
  resumeArtifactId?: string | undefined;
  applicationUrl?: string | undefined;
  referral?: string | undefined;
  source?: string | undefined;
  evaluationId?: string | undefined;
  decisionAtApply?: EvaluationDecision | undefined;
  scoreAtApply?: number | undefined;
  note?: string | undefined;
}

export class ApplicationRepository {
  constructor(private readonly db: Database) {}

  findByJob(jobId: string): Application | undefined {
    const row = this.db.prepare('SELECT * FROM applications WHERE job_id = ?').get(jobId) as
      | ApplicationRow
      | undefined;
    return row ? mapApplication(row) : undefined;
  }

  get(id: string): Application | undefined {
    const row = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as ApplicationRow | undefined;
    return row ? mapApplication(row) : undefined;
  }

  /**
   * Records an application, or updates the one that already exists.
   *
   * One application per role: re-recording is the user correcting a detail, not
   * a second application, and the unique index on `job_id` makes that explicit.
   */
  record(input: RecordApplicationInput): Application {
    const existing = this.findByJob(input.jobId);
    const timestamp = nowIso();
    const status = input.status ?? 'APPLIED';
    const appliedAt = input.appliedAt ?? timestamp;

    const write = this.db.transaction(() => {
      const id = existing?.id ?? randomId('app');

      if (existing) {
        this.db
          .prepare(
            `UPDATE applications SET
               applied_at = COALESCE(@applied_at, applied_at),
               current_status = @status,
               archetype_id = COALESCE(@archetype_id, archetype_id),
               generation_id = COALESCE(@generation_id, generation_id),
               resume_artifact_id = COALESCE(@resume_artifact_id, resume_artifact_id),
               application_url = COALESCE(@application_url, application_url),
               referral = COALESCE(@referral, referral),
               source = COALESCE(@source, source),
               evaluation_id = COALESCE(@evaluation_id, evaluation_id),
               decision_at_apply = COALESCE(@decision, decision_at_apply),
               score_at_apply = COALESCE(@score, score_at_apply)
             WHERE id = @id`,
          )
          .run({
            id,
            applied_at: toDb(appliedAt),
            status,
            archetype_id: toDb(input.archetypeId),
            generation_id: toDb(input.generationId),
            resume_artifact_id: toDb(input.resumeArtifactId),
            application_url: toDb(input.applicationUrl),
            referral: toDb(input.referral),
            source: toDb(input.source),
            evaluation_id: toDb(input.evaluationId),
            decision: toDb(input.decisionAtApply),
            score: toDb(input.scoreAtApply),
          });
      } else {
        this.db
          .prepare(
            `INSERT INTO applications (
               id, job_id, created_at, applied_at, current_status, archetype_id, generation_id,
               resume_artifact_id, application_url, referral, source,
               evaluation_id, decision_at_apply, score_at_apply
             ) VALUES (
               @id, @job_id, @now, @applied_at, @status, @archetype_id, @generation_id,
               @resume_artifact_id, @application_url, @referral, @source,
               @evaluation_id, @decision, @score
             )`,
          )
          .run({
            id,
            job_id: input.jobId,
            now: timestamp,
            applied_at: toDb(appliedAt),
            status,
            archetype_id: toDb(input.archetypeId),
            generation_id: toDb(input.generationId),
            resume_artifact_id: toDb(input.resumeArtifactId),
            application_url: toDb(input.applicationUrl),
            referral: toDb(input.referral),
            source: toDb(input.source),
            evaluation_id: toDb(input.evaluationId),
            decision: toDb(input.decisionAtApply),
            score: toDb(input.scoreAtApply),
          });
      }

      this.appendEvent(id, existing?.currentStatus, status, {
        ...(input.note === undefined ? {} : { note: input.note }),
        occurredAt: appliedAt,
      });

      return id;
    });

    const id = write();
    const saved = this.get(id);
    if (!saved) throw new Error(`application ${id} disappeared during write`);
    return saved;
  }

  /** Moves an application to a new state, keeping the previous one on record. */
  setStatus(
    applicationId: string,
    status: ApplicationStatus,
    options: { note?: string; occurredAt?: IsoTimestamp; source?: string } = {},
  ): Application {
    const current = this.get(applicationId);
    if (!current) throw new Error(`no application ${applicationId}`);

    const timestamp = options.occurredAt ?? nowIso();
    const closed = status === 'REJECTED' || status === 'WITHDRAWN' || status === 'CLOSED';

    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE applications SET current_status = @status, closed_at = @closed_at WHERE id = @id`,
        )
        .run({ id: applicationId, status, closed_at: closed ? timestamp : null });

      this.appendEvent(applicationId, current.currentStatus, status, {
        ...(options.note === undefined ? {} : { note: options.note }),
        occurredAt: timestamp,
        ...(options.source === undefined ? {} : { source: options.source }),
      });
    });

    write();

    const saved = this.get(applicationId);
    if (!saved) throw new Error(`application ${applicationId} disappeared during write`);
    return saved;
  }

  private appendEvent(
    applicationId: string,
    from: ApplicationStatus | undefined,
    to: ApplicationStatus,
    options: { note?: string; occurredAt?: IsoTimestamp; source?: string } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO application_status_events (id, application_id, from_status, to_status, occurred_at, notes, source)
         VALUES (@id, @application_id, @from_status, @to_status, @occurred_at, @notes, @source)`,
      )
      .run({
        id: randomId('ase'),
        application_id: applicationId,
        from_status: toDb(from),
        to_status: to,
        occurred_at: options.occurredAt ?? nowIso(),
        notes: toDb(options.note),
        source: options.source ?? 'user',
      });
  }

  history(applicationId: string): StatusEvent[] {
    // Ordered by insertion within the same instant. Two transitions recorded in
    // the same millisecond are common — recording an application and correcting
    // its status immediately — and the id is random, so falling back to it
    // shuffled the history at random.
    const rows = this.db
      .prepare('SELECT * FROM application_status_events WHERE application_id = ? ORDER BY occurred_at, rowid')
      .all(applicationId) as StatusEventRow[];
    return rows.map(mapEvent);
  }

  list(filters: { status?: ApplicationStatus; open?: boolean; limit?: number } = {}): Application[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: filters.limit ?? 100 };

    if (filters.status) {
      clauses.push('current_status = @status');
      params['status'] = filters.status;
    }
    if (filters.open) clauses.push('closed_at IS NULL');

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM applications ${where} ORDER BY COALESCE(applied_at, created_at) DESC LIMIT @limit`)
      .all(params) as ApplicationRow[];

    return rows.map(mapApplication);
  }

  countsByStatus(): { status: ApplicationStatus; count: number }[] {
    const rows = this.db
      .prepare('SELECT current_status AS status, COUNT(*) AS n FROM applications GROUP BY current_status')
      .all() as { status: string; n: number }[];
    return rows.map((row) => ({ status: row.status as ApplicationStatus, count: row.n }));
  }

  /** Feedback is written whether the user agreed with the advice or not. */
  recordFeedback(input: Omit<RoleFeedback, 'id' | 'createdAt'>): RoleFeedback {
    const id = randomId('fb');

    this.db
      .prepare(
        `INSERT INTO role_feedback (id, job_id, evaluation_id, kind, decision, score, reason, created_at)
         VALUES (@id, @job_id, @evaluation_id, @kind, @decision, @score, @reason, @now)`,
      )
      .run({
        id,
        job_id: input.jobId,
        evaluation_id: toDb(input.evaluationId),
        kind: input.kind,
        decision: toDb(input.decision),
        score: toDb(input.score),
        reason: toDb(input.reason),
        now: nowIso(),
      });

    const row = this.db.prepare('SELECT * FROM role_feedback WHERE id = ?').get(id) as FeedbackRow;
    return mapFeedback(row);
  }

  feedbackForJob(jobId: string): RoleFeedback[] {
    const rows = this.db
      .prepare('SELECT * FROM role_feedback WHERE job_id = ? ORDER BY created_at')
      .all(jobId) as FeedbackRow[];
    return rows.map(mapFeedback);
  }

  /** How often the user overrode the advice, which is the learning loop's input. */
  feedbackSummary(): { kind: FeedbackKind; count: number }[] {
    const rows = this.db
      .prepare('SELECT kind, COUNT(*) AS n FROM role_feedback GROUP BY kind ORDER BY n DESC')
      .all() as { kind: string; n: number }[];
    return rows.map((row) => ({ kind: row.kind as FeedbackKind, count: row.n }));
  }
}

export interface Note {
  id: string;
  jobId: string | undefined;
  applicationId: string | undefined;
  createdAt: IsoTimestamp;
  kind: string;
  text: string;
}

interface NoteRow {
  id: string;
  job_id: string | null;
  application_id: string | null;
  company_id: string | null;
  created_at: string;
  kind: string;
  text: string;
  private: number;
}

function mapNote(row: NoteRow): Note {
  return {
    id: row.id,
    jobId: fromDb(row.job_id),
    applicationId: fromDb(row.application_id),
    createdAt: row.created_at,
    kind: row.kind,
    text: row.text,
  };
}

/** Notes are private by default and never leave the machine. */
export class NoteRepository {
  constructor(private readonly db: Database) {}

  add(input: {
    jobId?: string | undefined;
    applicationId?: string | undefined;
    companyId?: string | undefined;
    kind?: string;
    text: string;
  }): Note {
    const id = randomId('note');

    this.db
      .prepare(
        `INSERT INTO notes (id, job_id, application_id, company_id, created_at, kind, text, private)
         VALUES (@id, @job_id, @application_id, @company_id, @now, @kind, @text, 1)`,
      )
      .run({
        id,
        job_id: toDb(input.jobId),
        application_id: toDb(input.applicationId),
        company_id: toDb(input.companyId),
        now: nowIso(),
        kind: input.kind ?? 'note',
        text: input.text,
      });

    return mapNote(this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow);
  }

  listForJob(jobId: string): Note[] {
    const rows = this.db
      .prepare('SELECT * FROM notes WHERE job_id = ? ORDER BY created_at')
      .all(jobId) as NoteRow[];
    return rows.map(mapNote);
  }
}
