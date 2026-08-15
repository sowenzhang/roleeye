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
 * Every entry is anchored on word boundaries. The first version of this list
 * used bare substrings, and a cross-model review reproduced what that costs:
 * `age` matched "manage", `race` matched "embrace", `disab` matched "disable",
 * and `orientation` matched "object orientation". Five ordinary engineering
 * questions were being refused as protected, which teaches a user that the
 * protection is noise — the fastest way to make them stop reading it.
 *
 * The omissions were as bad in the other direction. Work authorisation is asked
 * with the verb before the noun far more often than after it, so "Are you
 * legally authorized to work in the United States?" — the commonest phrasing on
 * a US form — was treated as an ordinary question and could be answered from
 * the bank. That was found by running form inspection against a live posting.
 */
const SENSITIVE_PATTERNS = [
  // Work authorisation, immigration, and right to work.
  /\bvisas?\b|\bsponsor\w*\b|\bimmigration\b|\bcitizens?\w*\b|\bgreen\s*card\b|\bh-?1-?b\b/i,
  /work\s+(?:authoris|authoriz)ation|(?:authoris|authoriz)(?:ed|ation)\s+to\s+work|employment\s+(?:authoris|authoriz)ation/i,
  /eligib(?:le|ility)\s+to\s+work|legally\s+\w+\s+to\s+work|right\s+to\s+work|work\s+permit/i,

  // Protected characteristics and voluntary self-identification.
  /\bdisabilit\w*\b|\bdisabled\b|\bveterans?\b|\bmilitary\s+service\b|\bpregnan\w*\b/i,
  /\bgender\b|\bsex\b|\bsexual\s+orientation\b|\bpronouns?\b|\brace\b|\bracial\b|\bethnic\w*\b/i,
  /\bnational\s+origin\b|\bancestry\b|\breligio\w+\b|\bmarital\s+status\b|\bmarried\b/i,
  /\bage\b|\bdate\s+of\s+birth\b|\bdob\b|\bself-?identif\w*\b|\beeoc?\b/i,

  // Compensation.
  /\bsalary\b|\bcompensation\b|\bwages?\b|\bhourly\s+rate\b|\bote\b/i,
  /(?:pay|salary|compensation|rate)\s+(?:expectation|range|requirement)\w*|(?:current|desired|expected|target)\s+(?:pay|salary|compensation|rate)/i,

  // Background checks.
  /\bcriminal\b|\bconvict\w*\b|\bfelony\b|background\s+(?:check|screen)\w*|drug\s+(?:test|screen)\w*/i,
];

export function isSensitiveQuestion(question: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(question));
}

/**
 * Full text of a question, normalised only for punctuation and spacing.
 *
 * This is identity. `questionKey` below is deliberately lossy so two phrasings
 * of the same question share a row, and a lossy key must never be the only
 * thing standing between a protected question and somebody else's answer.
 */
export function normalizeQuestionText(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable key for a question, so wording changes do not create duplicates. */
export function questionKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|do|does|you|your|will|would|are|is|to|of|for|in|on|at|please|kindly)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
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

  /**
   * Records that a form asked something, without touching an existing row.
   *
   * `upsert` would rewrite a stored answer's metadata and, because a
   * placeholder legitimately has no answer, would report it as newly created
   * on every inspection. "Stored 12 questions" printed twice for the same 12
   * questions is a lie about work the user still has to do.
   */
  ensurePlaceholder(question: string): { created: boolean; answer: StoredAnswer } {
    const key = questionKey(question);

    const existing = this.db
      .prepare(`SELECT * FROM application_answers WHERE question_key = ? AND scope = 'universal'`)
      .get(key) as AnswerRow | undefined;

    if (existing) return { created: false, answer: mapAnswer(existing) };

    return { created: true, answer: this.upsert({ questionText: question, answer: undefined }) };
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
   *
   * Two rules stand between the lossy key and a wrong answer, both added after
   * a review demonstrated the attack: a stored answer must agree with the
   * question about whether it is protected, and a protected question must match
   * the *whole* stored question, not a key derived from its first 160
   * significant characters. Without them an employer could write an ordinary
   * question sharing a key prefix with a protected one and be shown the user's
   * answer to the wrong thing.
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

    const usable = candidates.map(mapAnswer).filter((answer) => {
      // A protected question and an ordinary one never share an answer, in
      // either direction: the key is lossy and sensitivity is not.
      if (answer.sensitive !== sensitive) return false;
      if (!sensitive) return true;
      return normalizeQuestionText(answer.questionText) === normalizeQuestionText(question);
    });

    let match: StoredAnswer | undefined;

    for (const [scope, value] of preference) {
      const found = usable.find(
        (answer) => answer.scope === scope && (scope === 'universal' || answer.scopeValue === value),
      );
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
