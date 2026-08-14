import { randomId } from '../../util/hash.js';
import { nowIso, type IsoTimestamp } from '../../util/time.js';
import type { Database } from '../database.js';
import { fromDb, toDb } from './row-mapping.js';

/**
 * The application question bank (docs/vision.md §8).
 *
 * Provenance, permitted transformation, sensitivity, scope and freshness are
 * independent attributes rather than one category. The earlier three-way split
 * — recalled / composed / never invented — collapsed on contact with real
 * forms: work authorisation is recalled *and* protected, and compensation
 * belonged to two buckets at once.
 *
 * The rule that matters most is the one about sensitivity: a protected question
 * with no stored answer is reported as unanswered. It is never filled from a
 * similar-looking previous answer, because "similar" is exactly the judgement
 * nobody wants a machine making about their immigration status.
 */

export type AnswerProvenance = 'user_stated' | 'system_derived' | 'model_drafted';
export type AnswerTransformation = 'exact' | 'formatting' | 'calculated' | 'drafted';
export type AnswerScope = 'universal' | 'employer' | 'jurisdiction' | 'role';

export interface StoredAnswer {
  id: string;
  questionKey: string;
  questionText: string;
  answer: string | undefined;
  provenance: AnswerProvenance;
  transformation: AnswerTransformation;
  sensitive: boolean;
  scope: AnswerScope;
  scopeValue: string | undefined;
  factIds: string[];
  confirmedAt: IsoTimestamp | undefined;
  expiresAt: IsoTimestamp | undefined;
  requiresConfirmation: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

interface AnswerRow {
  id: string;
  question_key: string;
  question_text: string;
  answer: string | null;
  provenance: string;
  transformation: string;
  sensitive: number;
  scope: string;
  scope_value: string | null;
  fact_ids_json: string;
  confirmed_at: string | null;
  expires_at: string | null;
  requires_confirmation: number;
  created_at: string;
  updated_at: string;
}

function parseList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function mapAnswer(row: AnswerRow): StoredAnswer {
  return {
    id: row.id,
    questionKey: row.question_key,
    questionText: row.question_text,
    answer: fromDb(row.answer),
    provenance: row.provenance as AnswerProvenance,
    transformation: row.transformation as AnswerTransformation,
    sensitive: row.sensitive === 1,
    scope: row.scope as AnswerScope,
    scopeValue: fromDb(row.scope_value),
    factIds: parseList(row.fact_ids_json),
    confirmedAt: fromDb(row.confirmed_at),
    expiresAt: fromDb(row.expires_at),
    requiresConfirmation: row.requires_confirmation === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Questions that are protected regardless of how they are phrased.
 *
 * Matched on the normalised key, so "Do you now or in the future require
 * sponsorship?" and "Will you require visa sponsorship?" both land here.
 */
const SENSITIVE_PATTERNS = [
  /visa|sponsor|work.?authoris|work.?authoriz|immigration|citizen|right.to.work/i,
  /disab|veteran|military|gender|race|ethnic|orientation|religion|pregnan|marital|age\b|date.of.birth/i,
  /salary|compensation|pay.expectation|current.pay|desired.pay/i,
  /criminal|conviction|background.check|drug.test/i,
];

export function isSensitiveQuestion(question: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(question));
}

/** Stable key for a question, so wording changes do not create duplicates. */
export function questionKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|do|does|you|your|will|would|are|is|to|of|for|in|on|at|please|kindly)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export interface UpsertAnswerInput {
  questionText: string;
  answer: string | undefined;
  provenance?: AnswerProvenance;
  transformation?: AnswerTransformation;
  sensitive?: boolean;
  scope?: AnswerScope;
  scopeValue?: string | undefined;
  factIds?: string[];
  expiresAt?: IsoTimestamp | undefined;
  requiresConfirmation?: boolean;
  confirmed?: boolean;
}

export interface AnswerLookup {
  question: string;
  /** The answer to use, if one may be used at all. */
  answer: StoredAnswer | undefined;
  status: 'ready' | 'needs-confirmation' | 'expired' | 'unanswered' | 'blocked-sensitive';
  detail: string;
}

export class AnswerRepository {
  constructor(private readonly db: Database) {}

  upsert(input: UpsertAnswerInput): StoredAnswer {
    const key = questionKey(input.questionText);
    const scope = input.scope ?? 'universal';
    const scopeValue = input.scopeValue;
    const timestamp = nowIso();
    const sensitive = input.sensitive ?? isSensitiveQuestion(input.questionText);

    const existing = this.db
      .prepare(
        `SELECT * FROM application_answers
         WHERE question_key = ? AND scope = ? AND COALESCE(scope_value, '') = ?`,
      )
      .get(key, scope, scopeValue ?? '') as AnswerRow | undefined;

    const id = existing?.id ?? randomId('ans');

    const values = {
      id,
      question_key: key,
      question_text: input.questionText,
      answer: toDb(input.answer),
      provenance: input.provenance ?? 'user_stated',
      transformation: input.transformation ?? 'exact',
      sensitive: sensitive ? 1 : 0,
      scope,
      scope_value: toDb(scopeValue),
      fact_ids: JSON.stringify(input.factIds ?? []),
      // Editing an answer withdraws its confirmation: the user confirmed the
      // old words, exactly as with facts.
      confirmed_at: input.confirmed ? timestamp : null,
      expires_at: toDb(input.expiresAt),
      requires_confirmation: (input.requiresConfirmation ?? sensitive) ? 1 : 0,
      now: timestamp,
    };

    if (existing) {
      this.db
        .prepare(
          `UPDATE application_answers SET
             question_text = @question_text, answer = @answer, provenance = @provenance,
             transformation = @transformation, sensitive = @sensitive, fact_ids_json = @fact_ids,
             confirmed_at = @confirmed_at, expires_at = @expires_at,
             requires_confirmation = @requires_confirmation, updated_at = @now
           WHERE id = @id`,
        )
        .run(values);
    } else {
      this.db
        .prepare(
          `INSERT INTO application_answers (
             id, question_key, question_text, answer, provenance, transformation, sensitive,
             scope, scope_value, fact_ids_json, confirmed_at, expires_at, requires_confirmation,
             created_at, updated_at
           ) VALUES (
             @id, @question_key, @question_text, @answer, @provenance, @transformation, @sensitive,
             @scope, @scope_value, @fact_ids, @confirmed_at, @expires_at, @requires_confirmation,
             @now, @now
           )`,
        )
        .run(values);
    }

    const row = this.db.prepare('SELECT * FROM application_answers WHERE id = ?').get(id) as AnswerRow;
    return mapAnswer(row);
  }

  confirm(id: string): void {
    this.db
      .prepare('UPDATE application_answers SET confirmed_at = @now, updated_at = @now WHERE id = @id')
      .run({ id, now: nowIso() });
  }

  list(): StoredAnswer[] {
    const rows = this.db
      .prepare('SELECT * FROM application_answers ORDER BY sensitive DESC, question_key')
      .all() as AnswerRow[];
    return rows.map(mapAnswer);
  }

  /**
   * Finds the answer to use for a question, and says why when there is none.
   *
   * Scope order is deliberate: an employer-specific answer beats a universal
   * one, because "why this company" is not a standing fact. Nothing is ever
   * borrowed across a sensitive boundary.
   */
  lookup(question: string, context: { employer?: string; jurisdiction?: string; role?: string } = {}): AnswerLookup {
    const key = questionKey(question);
    const sensitive = isSensitiveQuestion(question);

    const candidates = this.db
      .prepare('SELECT * FROM application_answers WHERE question_key = ?')
      .all(key) as AnswerRow[];

    const preference: Array<[AnswerScope, string | undefined]> = [
      ['employer', context.employer],
      ['role', context.role],
      ['jurisdiction', context.jurisdiction],
      ['universal', undefined],
    ];

    let match: StoredAnswer | undefined;

    for (const [scope, value] of preference) {
      const found = candidates
        .map(mapAnswer)
        .find((answer) => answer.scope === scope && (scope === 'universal' || answer.scopeValue === value));
      if (found) {
        match = found;
        break;
      }
    }

    if (!match || match.answer === undefined || match.answer.trim().length === 0) {
      return {
        question,
        answer: undefined,
        status: sensitive ? 'blocked-sensitive' : 'unanswered',
        detail: sensitive
          ? 'protected question with no stored answer: it is reported, never inferred from a similar answer'
          : 'no stored answer for this question',
      };
    }

    const now = nowIso();

    if (match.expiresAt && match.expiresAt <= now) {
      return { question, answer: match, status: 'expired', detail: `answer expired on ${match.expiresAt}` };
    }

    if (match.requiresConfirmation && !match.confirmedAt) {
      return {
        question,
        answer: match,
        status: 'needs-confirmation',
        detail: 'stored, but a human must re-affirm it for this application',
      };
    }

    return { question, answer: match, status: 'ready', detail: `${match.provenance} · ${match.transformation}` };
  }

  recordUse(input: {
    applicationId: string;
    answerId: string | undefined;
    questionText: string;
    usedAnswer: string | undefined;
    confirmed: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO application_answer_uses (id, application_id, answer_id, question_text, used_answer, confirmed, created_at)
         VALUES (@id, @application_id, @answer_id, @question_text, @used_answer, @confirmed, @now)`,
      )
      .run({
        id: randomId('use'),
        application_id: input.applicationId,
        answer_id: toDb(input.answerId),
        question_text: input.questionText,
        used_answer: toDb(input.usedAnswer),
        confirmed: input.confirmed ? 1 : 0,
        now: nowIso(),
      });
  }

  usesForApplication(applicationId: string): Array<{ questionText: string; usedAnswer: string | undefined; confirmed: boolean }> {
    const rows = this.db
      .prepare('SELECT question_text, used_answer, confirmed FROM application_answer_uses WHERE application_id = ? ORDER BY created_at')
      .all(applicationId) as { question_text: string; used_answer: string | null; confirmed: number }[];

    return rows.map((row) => ({
      questionText: row.question_text,
      usedAnswer: fromDb(row.used_answer),
      confirmed: row.confirmed === 1,
    }));
  }
}
