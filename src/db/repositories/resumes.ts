import { randomId } from '../../util/hash.js';
import { nowIso, type IsoTimestamp } from '../../util/time.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

/**
 * Archetype assignments, generated resumes, and the claims inside them.
 *
 * Assignments record *how* they were made. A user who corrects the classifier
 * has said something the classifier cannot know, so a later automatic pass must
 * never quietly overwrite it.
 */

export type AssignmentMethod = 'deterministic' | 'manual' | 'model';

export interface ArchetypeAssignment {
  id: string;
  jobId: string;
  archetypeId: string | undefined;
  archetypeHash: string;
  score: number;
  runnerUpId: string | undefined;
  runnerUpScore: number | undefined;
  method: AssignmentMethod;
  evidence: string[];
  assignedAt: IsoTimestamp;
}

interface AssignmentRow {
  id: string;
  job_id: string;
  archetype_id: string | null;
  archetype_hash: string;
  score: number;
  runner_up_id: string | null;
  runner_up_score: number | null;
  method: string;
  evidence_json: string;
  assigned_at: string;
}

function parseList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function mapAssignment(row: AssignmentRow): ArchetypeAssignment {
  return {
    id: row.id,
    jobId: row.job_id,
    archetypeId: fromDb(row.archetype_id),
    archetypeHash: row.archetype_hash,
    score: row.score,
    runnerUpId: fromDb(row.runner_up_id),
    runnerUpScore: fromDb(row.runner_up_score),
    method: row.method as AssignmentMethod,
    evidence: parseList(row.evidence_json),
    assignedAt: row.assigned_at,
  };
}

export class ArchetypeAssignmentRepository {
  constructor(private readonly db: Database) {}

  save(input: Omit<ArchetypeAssignment, 'id' | 'assignedAt'> & { assignedAt?: IsoTimestamp }): ArchetypeAssignment {
    const existing = this.find(input.jobId, input.archetypeHash);
    const id = existing?.id ?? randomId('asg');

    this.db
      .prepare(
        `INSERT INTO archetype_assignments (
           id, job_id, archetype_id, archetype_hash, score, runner_up_id, runner_up_score,
           method, evidence_json, assigned_at
         ) VALUES (
           @id, @job_id, @archetype_id, @archetype_hash, @score, @runner_up_id, @runner_up_score,
           @method, @evidence, @assigned_at
         )
         ON CONFLICT(job_id, archetype_hash) DO UPDATE SET
           archetype_id = excluded.archetype_id,
           score = excluded.score,
           runner_up_id = excluded.runner_up_id,
           runner_up_score = excluded.runner_up_score,
           method = excluded.method,
           evidence_json = excluded.evidence_json,
           assigned_at = excluded.assigned_at`,
      )
      .run({
        id,
        job_id: input.jobId,
        archetype_id: toDb(input.archetypeId),
        archetype_hash: input.archetypeHash,
        score: input.score,
        runner_up_id: toDb(input.runnerUpId),
        runner_up_score: toDb(input.runnerUpScore),
        method: input.method,
        evidence: JSON.stringify(input.evidence),
        assigned_at: input.assignedAt ?? nowIso(),
      });

    const saved = this.find(input.jobId, input.archetypeHash);
    if (!saved) throw new Error(`assignment for ${input.jobId} disappeared during write`);
    return saved;
  }

  find(jobId: string, archetypeHash: string): ArchetypeAssignment | undefined {
    const row = this.db
      .prepare('SELECT * FROM archetype_assignments WHERE job_id = ? AND archetype_hash = ?')
      .get(jobId, archetypeHash) as AssignmentRow | undefined;
    return row ? mapAssignment(row) : undefined;
  }

  latestForJob(jobId: string): ArchetypeAssignment | undefined {
    const row = this.db
      .prepare('SELECT * FROM archetype_assignments WHERE job_id = ? ORDER BY assigned_at DESC LIMIT 1')
      .get(jobId) as AssignmentRow | undefined;
    return row ? mapAssignment(row) : undefined;
  }

  /** Manual corrections survive a re-classification; that is their point. */
  manualForJob(jobId: string): ArchetypeAssignment | undefined {
    const row = this.db
      .prepare(`SELECT * FROM archetype_assignments WHERE job_id = ? AND method = 'manual' ORDER BY assigned_at DESC LIMIT 1`)
      .get(jobId) as AssignmentRow | undefined;
    return row ? mapAssignment(row) : undefined;
  }

  countsByArchetype(archetypeHash: string): { archetypeId: string; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(archetype_id, '(unassigned)') AS archetype_id, COUNT(*) AS n
         FROM archetype_assignments WHERE archetype_hash = ?
         GROUP BY archetype_id ORDER BY n DESC`,
      )
      .all(archetypeHash) as { archetype_id: string; n: number }[];

    return rows.map((row) => ({ archetypeId: row.archetype_id, count: row.n }));
  }
}

export interface ResumeClaim {
  id: string;
  generationId: string;
  section: string;
  position: number;
  text: string;
  factIds: string[];
  supported: boolean;
  problems: string[];
}

export interface ResumeGeneration {
  id: string;
  archetypeId: string;
  archetypeHash: string;
  factSetHash: string;
  profileHash: string;
  provider: string;
  model: string;
  headline: string | undefined;
  summary: string | undefined;
  document: unknown;
  validated: boolean;
  createdAt: IsoTimestamp;
  supersededAt: IsoTimestamp | undefined;
}

interface GenerationRow {
  id: string;
  archetype_id: string;
  archetype_hash: string;
  fact_set_hash: string;
  profile_hash: string;
  provider: string;
  model: string;
  headline: string | null;
  summary: string | null;
  document_json: string;
  validated: number;
  created_at: string;
  superseded_at: string | null;
}

interface ClaimRow {
  id: string;
  generation_id: string;
  section: string;
  position: number;
  text: string;
  fact_ids_json: string;
  supported: number;
  problems_json: string;
}

function mapGeneration(row: GenerationRow): ResumeGeneration {
  let document: unknown;
  try {
    document = JSON.parse(row.document_json);
  } catch {
    document = undefined;
  }

  return {
    id: row.id,
    archetypeId: row.archetype_id,
    archetypeHash: row.archetype_hash,
    factSetHash: row.fact_set_hash,
    profileHash: row.profile_hash,
    provider: row.provider,
    model: row.model,
    headline: fromDb(row.headline),
    summary: fromDb(row.summary),
    document,
    validated: row.validated === 1,
    createdAt: row.created_at,
    supersededAt: fromDb(row.superseded_at),
  };
}

function mapClaim(row: ClaimRow): ResumeClaim {
  return {
    id: row.id,
    generationId: row.generation_id,
    section: row.section,
    position: row.position,
    text: row.text,
    factIds: parseList(row.fact_ids_json),
    supported: row.supported === 1,
    problems: parseList(row.problems_json),
  };
}

export interface SaveGenerationInput {
  archetypeId: string;
  archetypeHash: string;
  factSetHash: string;
  profileHash: string;
  provider: string;
  model: string;
  headline: string;
  summary: string;
  document: unknown;
  validated: boolean;
  claims: Omit<ResumeClaim, 'id' | 'generationId'>[];
}

export class ResumeRepository {
  constructor(private readonly db: Database) {}

  save(input: SaveGenerationInput): ResumeGeneration {
    const id = randomId('gen');
    const timestamp = nowIso();

    const write = this.db.transaction(() => {
      // A newer generation replaces the previous one for that archetype, but
      // the old row stays: the diff between them is a product feature.
      this.db
        .prepare(
          `UPDATE resume_generations SET superseded_at = @now
           WHERE archetype_id = @archetype_id AND superseded_at IS NULL`,
        )
        .run({ archetype_id: input.archetypeId, now: timestamp });

      this.db
        .prepare(
          `INSERT INTO resume_generations (
             id, archetype_id, archetype_hash, fact_set_hash, profile_hash, provider, model,
             headline, summary, document_json, validated, created_at
           ) VALUES (
             @id, @archetype_id, @archetype_hash, @fact_set_hash, @profile_hash, @provider, @model,
             @headline, @summary, @document, @validated, @now
           )`,
        )
        .run({
          id,
          archetype_id: input.archetypeId,
          archetype_hash: input.archetypeHash,
          fact_set_hash: input.factSetHash,
          profile_hash: input.profileHash,
          provider: input.provider,
          model: input.model,
          headline: input.headline,
          summary: input.summary,
          document: JSON.stringify(input.document ?? null),
          validated: input.validated ? 1 : 0,
          now: timestamp,
        });

      const claim = this.db.prepare(
        `INSERT INTO resume_claims (id, generation_id, section, position, text, fact_ids_json, supported, problems_json)
         VALUES (@id, @generation_id, @section, @position, @text, @fact_ids, @supported, @problems)`,
      );

      for (const entry of input.claims) {
        claim.run({
          id: randomId('clm'),
          generation_id: id,
          section: entry.section,
          position: entry.position,
          text: entry.text,
          fact_ids: JSON.stringify(entry.factIds),
          supported: entry.supported ? 1 : 0,
          problems: JSON.stringify(entry.problems),
        });
      }
    });

    write();

    return this.require(id);
  }

  get(id: string): ResumeGeneration | undefined {
    const row = this.db.prepare('SELECT * FROM resume_generations WHERE id = ?').get(id) as
      | GenerationRow
      | undefined;
    return row ? mapGeneration(row) : undefined;
  }

  private require(id: string): ResumeGeneration {
    const generation = this.get(id);
    if (!generation) throw new Error(`generation ${id} disappeared during write`);
    return generation;
  }

  current(archetypeId: string): ResumeGeneration | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM resume_generations WHERE archetype_id = ? AND superseded_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(archetypeId) as GenerationRow | undefined;
    return row ? mapGeneration(row) : undefined;
  }

  history(archetypeId: string, limit = 10): ResumeGeneration[] {
    const rows = this.db
      .prepare('SELECT * FROM resume_generations WHERE archetype_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(archetypeId, limit) as GenerationRow[];
    return rows.map(mapGeneration);
  }

  claims(generationId: string): ResumeClaim[] {
    const rows = this.db
      .prepare('SELECT * FROM resume_claims WHERE generation_id = ? ORDER BY section, position')
      .all(generationId) as ClaimRow[];
    return rows.map(mapClaim);
  }
}

export interface ArtifactRecord {
  id: string;
  jobId: string | undefined;
  generationId: string | undefined;
  archetypeId: string | undefined;
  snapshotId: string | undefined;
  type: string;
  path: string;
  checksum: string | undefined;
  contentHash: string | undefined;
  createdAt: IsoTimestamp;
  supersededAt: IsoTimestamp | undefined;
}

interface ArtifactRow {
  id: string;
  job_id: string | null;
  application_id: string | null;
  generation_id: string | null;
  archetype_id: string | null;
  snapshot_id: string | null;
  type: string;
  path: string;
  checksum: string | null;
  content_hash: string | null;
  created_at: string;
  superseded_at: string | null;
  metadata_json: string | null;
}

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    jobId: fromDb(row.job_id),
    generationId: fromDb(row.generation_id),
    archetypeId: fromDb(row.archetype_id),
    snapshotId: fromDb(row.snapshot_id),
    type: row.type,
    path: row.path,
    checksum: fromDb(row.checksum),
    contentHash: fromDb(row.content_hash),
    createdAt: row.created_at,
    supersededAt: fromDb(row.superseded_at),
  };
}

export class ArtifactRepository {
  constructor(private readonly db: Database) {}

  /** Path is unique, so re-rendering updates the row rather than growing it. */
  record(input: {
    jobId?: string | undefined;
    generationId?: string | undefined;
    archetypeId?: string | undefined;
    snapshotId?: string | undefined;
    type: string;
    path: string;
    checksum: string;
    contentHash?: string | undefined;
    metadata?: unknown;
  }): ArtifactRecord {
    const id = randomId('art');

    this.db
      .prepare(
        `INSERT INTO artifacts (
           id, job_id, application_id, generation_id, archetype_id, snapshot_id,
           type, path, checksum, content_hash, created_at, metadata_json
         ) VALUES (
           @id, @job_id, NULL, @generation_id, @archetype_id, @snapshot_id,
           @type, @path, @checksum, @content_hash, @now, @metadata
         )
         ON CONFLICT(path) DO UPDATE SET
           job_id = excluded.job_id,
           generation_id = excluded.generation_id,
           archetype_id = excluded.archetype_id,
           snapshot_id = excluded.snapshot_id,
           type = excluded.type,
           checksum = excluded.checksum,
           content_hash = excluded.content_hash,
           created_at = excluded.created_at,
           superseded_at = NULL,
           metadata_json = excluded.metadata_json`,
      )
      .run({
        id,
        job_id: toDb(input.jobId),
        generation_id: toDb(input.generationId),
        archetype_id: toDb(input.archetypeId),
        snapshot_id: toDb(input.snapshotId),
        type: input.type,
        path: input.path,
        checksum: input.checksum,
        content_hash: toDb(input.contentHash),
        now: nowIso(),
        metadata: input.metadata === undefined ? null : JSON.stringify(input.metadata),
      });

    const row = this.db.prepare('SELECT * FROM artifacts WHERE path = ?').get(input.path) as ArtifactRow;
    return mapArtifact(row);
  }

  listForJob(jobId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at DESC')
      .all(jobId) as ArtifactRow[];
    return rows.map(mapArtifact);
  }

  listForArchetype(archetypeId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE archetype_id = ? ORDER BY created_at DESC')
      .all(archetypeId) as ArtifactRow[];
    return rows.map(mapArtifact);
  }
}
