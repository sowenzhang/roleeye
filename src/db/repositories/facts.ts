import { randomId, sha256, shortHash } from '../../util/hash.js';
import { nowIso, type IsoTimestamp } from '../../util/time.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

/**
 * The fact store.
 *
 * Two rules are enforced here rather than left to callers, because every
 * generated claim in the product depends on them:
 *
 * 1. A fact is usable only when a human has approved it.
 * 2. Approval is bound to the exact words. Change the statement and the fact
 *    returns to draft, because what was approved no longer exists.
 */

export type FactStatus = 'draft' | 'approved';
export type FactOrigin = 'import' | 'manual';

export interface Experience {
  id: string;
  slug: string;
  company: string;
  role: string;
  startedOn: string | undefined;
  endedOn: string | undefined;
  sortOrder: number;
}

export interface Fact {
  id: string;
  experienceId: string | undefined;
  statement: string;
  statementHash: string;
  tags: string[];
  status: FactStatus;
  approvedAt: IsoTimestamp | undefined;
  importId: string | undefined;
  origin: FactOrigin;
  retiredAt: IsoTimestamp | undefined;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface FactImport {
  id: string;
  sourcePath: string;
  sourceSha256: string;
  format: string;
  bytes: number;
  extractor: string;
  extractorVersion: string;
  factsCreated: number;
  factsUpdated: number;
  factsUnchanged: number;
  warnings: string[];
  createdAt: IsoTimestamp;
}

interface ExperienceRow {
  id: string;
  slug: string;
  company: string;
  role: string;
  started_on: string | null;
  ended_on: string | null;
  sort_order: number;
}

interface FactRow {
  id: string;
  experience_id: string | null;
  statement: string;
  statement_hash: string;
  tags_json: string;
  status: string;
  approved_at: string | null;
  import_id: string | null;
  origin: string;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ImportRow {
  id: string;
  source_path: string;
  source_sha256: string;
  format: string;
  bytes: number;
  extractor: string;
  extractor_version: string;
  facts_created: number;
  facts_updated: number;
  facts_unchanged: number;
  warnings_json: string;
  created_at: string;
}

function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function mapExperience(row: ExperienceRow): Experience {
  return {
    id: row.id,
    slug: row.slug,
    company: row.company,
    role: row.role,
    startedOn: fromDb(row.started_on),
    endedOn: fromDb(row.ended_on),
    sortOrder: row.sort_order,
  };
}

function mapFact(row: FactRow): Fact {
  return {
    id: row.id,
    experienceId: fromDb(row.experience_id),
    statement: row.statement,
    statementHash: row.statement_hash,
    tags: parseTags(row.tags_json),
    status: row.status as FactStatus,
    approvedAt: fromDb(row.approved_at),
    importId: fromDb(row.import_id),
    origin: row.origin as FactOrigin,
    retiredAt: fromDb(row.retired_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapImport(row: ImportRow): FactImport {
  return {
    id: row.id,
    sourcePath: row.source_path,
    sourceSha256: row.source_sha256,
    format: row.format,
    bytes: row.bytes,
    extractor: row.extractor,
    extractorVersion: row.extractor_version,
    factsCreated: row.facts_created,
    factsUpdated: row.facts_updated,
    factsUnchanged: row.facts_unchanged,
    warnings: parseTags(row.warnings_json),
    createdAt: row.created_at,
  };
}

/**
 * Comparison form for a statement.
 *
 * Whitespace and case must not create a second copy of the same fact on
 * re-import, but they must also not hide a real edit: the stored statement is
 * the original text, and only the identity key is normalised.
 */
export function statementHash(statement: string): string {
  return sha256(statement.replace(/\s+/g, ' ').trim().toLowerCase());
}

export function experienceSlug(company: string, role: string): string {
  const base = `${company} ${role}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  return base.length > 0 ? base : `experience-${shortHash(`${company}|${role}`, 8)}`;
}

export interface UpsertFactInput {
  statement: string;
  tags?: string[];
  experienceId?: string | undefined;
  importId?: string | undefined;
  origin?: FactOrigin;
}

export type UpsertOutcome = 'created' | 'updated' | 'unchanged';

export class FactRepository {
  constructor(private readonly db: Database) {}

  upsertExperience(input: {
    company: string;
    role: string;
    startedOn?: string | undefined;
    endedOn?: string | undefined;
    sortOrder?: number;
  }): Experience {
    const slug = experienceSlug(input.company, input.role);
    const existing = this.db.prepare('SELECT * FROM experiences WHERE slug = ?').get(slug) as
      | ExperienceRow
      | undefined;

    if (existing) return mapExperience(existing);

    const id = randomId('exp');
    const timestamp = nowIso();

    this.db
      .prepare(
        `INSERT INTO experiences (id, slug, company, role, started_on, ended_on, sort_order, created_at, updated_at)
         VALUES (@id, @slug, @company, @role, @started_on, @ended_on, @sort_order, @now, @now)`,
      )
      .run({
        id,
        slug,
        company: input.company,
        role: input.role,
        started_on: toDb(input.startedOn),
        ended_on: toDb(input.endedOn),
        sort_order: input.sortOrder ?? 0,
        now: timestamp,
      });

    return mapExperience(this.db.prepare('SELECT * FROM experiences WHERE id = ?').get(id) as ExperienceRow);
  }

  listExperiences(): Experience[] {
    const rows = this.db
      .prepare('SELECT * FROM experiences ORDER BY sort_order, company')
      .all() as ExperienceRow[];
    return rows.map(mapExperience);
  }

  findExperienceBySlug(slug: string): Experience | undefined {
    const row = this.db.prepare('SELECT * FROM experiences WHERE slug = ?').get(slug) as ExperienceRow | undefined;
    return row ? mapExperience(row) : undefined;
  }

  /**
   * Adds a fact, or reconciles one that already exists.
   *
   * Re-importing an unchanged document must not produce duplicates or reset
   * approvals — that would make import unusable as a routine operation. An
   * edited statement is a different fact by identity, so it arrives as a new
   * draft rather than mutating an approved row.
   */
  upsert(input: UpsertFactInput): { fact: Fact; outcome: UpsertOutcome } {
    const statement = input.statement.trim();
    const hash = statementHash(statement);
    const timestamp = nowIso();

    const existing = this.db.prepare('SELECT * FROM facts WHERE statement_hash = ?').get(hash) as
      | FactRow
      | undefined;

    if (existing) {
      const current = mapFact(existing);
      const tags = input.tags ? [...new Set([...current.tags, ...input.tags])] : current.tags;
      const experienceId = current.experienceId ?? input.experienceId;
      const unchanged =
        tags.length === current.tags.length &&
        tags.every((tag) => current.tags.includes(tag)) &&
        experienceId === current.experienceId &&
        current.retiredAt === undefined;

      if (unchanged) return { fact: current, outcome: 'unchanged' };

      // Anything that changes the evidence behind a fact returns it to draft.
      //
      // Approval covers the statement *and* what it is attached to: the
      // employer, dates and tags of a fact are evidence a generated claim may
      // quote. A review showed an approved statement being re-imported under a
      // new employer and keeping its approval, which let an unreviewed company
      // name become quotable. Un-retiring is the same problem — the user
      // retired it deliberately.
      this.db
        .prepare(
          `UPDATE facts SET tags_json = @tags, experience_id = @experience_id, retired_at = NULL,
             status = 'draft', approved_at = NULL, updated_at = @now
           WHERE id = @id`,
        )
        .run({ id: current.id, tags: JSON.stringify(tags), experience_id: toDb(experienceId), now: timestamp });

      return { fact: this.requireFact(current.id), outcome: 'updated' };
    }

    const id = randomId('fact');

    this.db
      .prepare(
        `INSERT INTO facts (
           id, experience_id, statement, statement_hash, tags_json, status,
           approved_at, import_id, origin, created_at, updated_at
         ) VALUES (
           @id, @experience_id, @statement, @statement_hash, @tags, 'draft',
           NULL, @import_id, @origin, @now, @now
         )`,
      )
      .run({
        id,
        experience_id: toDb(input.experienceId),
        statement,
        statement_hash: hash,
        tags: JSON.stringify(input.tags ?? []),
        import_id: toDb(input.importId),
        origin: input.origin ?? 'import',
        now: timestamp,
      });

    return { fact: this.requireFact(id), outcome: 'created' };
  }

  /**
   * Replaces the text of a fact.
   *
   * Editing always returns the fact to draft. Approval was given to particular
   * words, and this is the single place that guarantee could be lost.
   */
  editStatement(id: string, statement: string): Fact {
    const trimmed = statement.trim();

    this.db
      .prepare(
        `UPDATE facts SET statement = @statement, statement_hash = @hash, status = 'draft',
           approved_at = NULL, updated_at = @now
         WHERE id = @id`,
      )
      .run({ id, statement: trimmed, hash: statementHash(trimmed), now: nowIso() });

    return this.requireFact(id);
  }

  approve(ids: string[]): number {
    if (ids.length === 0) return 0;
    const timestamp = nowIso();
    const statement = this.db.prepare(
      `UPDATE facts SET status = 'approved', approved_at = @now, updated_at = @now
       WHERE id = @id AND retired_at IS NULL AND status = 'draft'`,
    );

    const run = this.db.transaction((factIds: string[]) => {
      let changed = 0;
      for (const id of factIds) changed += statement.run({ id, now: timestamp }).changes;
      return changed;
    });

    return run(ids);
  }

  approveExperience(experienceId: string): number {
    const rows = this.db
      .prepare(`SELECT id FROM facts WHERE experience_id = ? AND status = 'draft' AND retired_at IS NULL`)
      .all(experienceId) as { id: string }[];

    return this.approve(rows.map((row) => row.id));
  }

  retire(id: string): void {
    this.db
      .prepare('UPDATE facts SET retired_at = @now, updated_at = @now WHERE id = @id')
      .run({ id, now: nowIso() });
  }

  get(id: string): Fact | undefined {
    const row = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as FactRow | undefined;
    return row ? mapFact(row) : undefined;
  }

  private requireFact(id: string): Fact {
    const fact = this.get(id);
    if (!fact) throw new Error(`fact ${id} disappeared during write`);
    return fact;
  }

  list(filters: { status?: FactStatus; experienceId?: string; includeRetired?: boolean } = {}): Fact[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters.status) {
      clauses.push('status = @status');
      params['status'] = filters.status;
    }
    if (filters.experienceId) {
      clauses.push('experience_id = @experienceId');
      params['experienceId'] = filters.experienceId;
    }
    if (!filters.includeRetired) clauses.push('retired_at IS NULL');

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM facts ${where} ORDER BY created_at`)
      .all(params) as FactRow[];

    return rows.map(mapFact);
  }

  /** The only list generation is allowed to draw on. */
  approvedFacts(): Fact[] {
    return this.list({ status: 'approved' });
  }

  /**
   * Identity of the approved set, for staleness detection.
   *
   * Statement hashes rather than row ids: re-importing into a fresh database
   * produces different ids for the same words, and a resume generated from the
   * same words is not stale.
   *
   * Tags and employer are included because both change what a generation would
   * produce — tags decide which facts an archetype draws on, and the employer
   * is evidence a claim may quote. Hashing statements alone reported a resume
   * as current after re-tagging had removed a fact from its input set.
   */
  approvedSetHash(): string {
    const experiences = new Map(this.listExperiences().map((entry) => [entry.id, entry]));

    const parts = this.approvedFacts()
      .map((fact) => {
        const experience = fact.experienceId ? experiences.get(fact.experienceId) : undefined;
        const where = experience
          ? `${experience.company}|${experience.role}|${experience.startedOn ?? ''}|${experience.endedOn ?? ''}`
          : '';
        return `${fact.statementHash}|${[...fact.tags].sort().join(',')}|${where}`;
      })
      .sort();

    return sha256(parts.join('\n'));
  }

  counts(): { draft: number; approved: number; retired: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'draft' AND retired_at IS NULL THEN 1 ELSE 0 END) AS draft,
           SUM(CASE WHEN status = 'approved' AND retired_at IS NULL THEN 1 ELSE 0 END) AS approved,
           SUM(CASE WHEN retired_at IS NOT NULL THEN 1 ELSE 0 END) AS retired
         FROM facts`,
      )
      .get() as { draft: number | null; approved: number | null; retired: number | null };

    return { draft: row.draft ?? 0, approved: row.approved ?? 0, retired: row.retired ?? 0 };
  }

  recordImport(input: Omit<FactImport, 'id' | 'createdAt'>): FactImport {
    const id = randomId('imp');

    this.db
      .prepare(
        `INSERT INTO fact_imports (
           id, source_path, source_sha256, format, bytes, extractor, extractor_version,
           facts_created, facts_updated, facts_unchanged, warnings_json, created_at
         ) VALUES (
           @id, @source_path, @source_sha256, @format, @bytes, @extractor, @extractor_version,
           @facts_created, @facts_updated, @facts_unchanged, @warnings, @now
         )`,
      )
      .run({
        id,
        source_path: input.sourcePath,
        source_sha256: input.sourceSha256,
        format: input.format,
        bytes: input.bytes,
        extractor: input.extractor,
        extractor_version: input.extractorVersion,
        facts_created: input.factsCreated,
        facts_updated: input.factsUpdated,
        facts_unchanged: input.factsUnchanged,
        warnings: JSON.stringify(input.warnings),
        now: nowIso(),
      });

    return mapImport(this.db.prepare('SELECT * FROM fact_imports WHERE id = ?').get(id) as ImportRow);
  }

  updateImportCounts(
    id: string,
    counts: { created: number; updated: number; unchanged: number; warnings: string[] },
  ): void {
    this.db
      .prepare(
        `UPDATE fact_imports SET facts_created = @created, facts_updated = @updated,
           facts_unchanged = @unchanged, warnings_json = @warnings WHERE id = @id`,
      )
      .run({
        id,
        created: counts.created,
        updated: counts.updated,
        unchanged: counts.unchanged,
        warnings: JSON.stringify(counts.warnings),
      });
  }

  listImports(limit = 20): FactImport[] {
    const rows = this.db
      .prepare('SELECT * FROM fact_imports ORDER BY created_at DESC LIMIT ?')
      .all(limit) as ImportRow[];
    return rows.map(mapImport);
  }
}
