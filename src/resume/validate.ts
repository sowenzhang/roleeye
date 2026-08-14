import type { Fact } from '../db/repositories/facts.js';

/**
 * Claim validation.
 *
 * The product's central promise is that a generated resume says nothing the
 * user did not already claim about themselves and approve. A model asked to
 * "tailor" will otherwise round 43% up to "nearly half", turn a team of three
 * into "a large team", and add the technology the job asked for.
 *
 * So every generated bullet is checked in code against the facts it cites:
 * citations must be real and approved, numbers must come from the facts, and
 * named technologies must appear in them. Anything else is dropped before it
 * can reach a document.
 */

export interface ClaimProblem {
  code: 'no-citation' | 'unknown-fact' | 'unapproved-fact' | 'invented-number' | 'invented-term' | 'too-long';
  detail: string;
}

export interface ClaimInput {
  text: string;
  factIds: string[];
}

export interface ValidatedClaim {
  text: string;
  factIds: string[];
  supported: boolean;
  problems: ClaimProblem[];
}

const MAX_CLAIM_CHARS = 320;

/** Digits, percentages, multipliers, and money, in any of the written forms. */
const NUMBERS = /\$?\d[\d,.]*\s*(%|percent|x|k|m|b|bn|million|billion|hours?|days?|weeks?|months?|years?)?/gi;

/**
 * Terms whose presence is a factual claim: named technologies and acronyms.
 *
 * Capitalisation mid-sentence and all-caps acronyms are the reliable signals.
 * Sentence-initial words are excluded because every bullet starts with one.
 */
const NAMED_TERM = /\b([A-Z][a-zA-Z0-9+#.]*[a-z][a-zA-Z0-9+#.]*|[A-Z]{2,}[0-9]*)\b/g;

const COMMON_WORDS = new Set([
  'I', 'A', 'AN', 'THE', 'AND', 'OR', 'FOR', 'WITH', 'TO', 'OF', 'IN', 'ON', 'AT', 'BY',
  'CI', 'CD', 'IT', 'US', 'UK', 'EU', 'API', 'APIS', 'UI', 'UX', 'QA', 'OKR', 'KPI', 'ROI',
]);

function normalizeNumber(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s,$]/g, '')
    .replace(/percent$/, '%')
    .replace(/\.0+$/, '')
    .replace(/(million|mm)$/, 'm')
    .replace(/(billion|bn)$/, 'b');
}

function numbersIn(text: string): string[] {
  return (text.match(NUMBERS) ?? []).map(normalizeNumber).filter((value) => value.length > 0);
}

function namedTermsIn(text: string, skipFirstWord: boolean): string[] {
  const body = skipFirstWord ? text.replace(/^\W*\S+\s*/, '') : text;
  const matches = body.match(NAMED_TERM) ?? [];

  return [...new Set(matches.map((term) => term.toUpperCase()))].filter(
    (term) => term.length > 1 && !COMMON_WORDS.has(term),
  );
}

export interface ValidateOptions {
  /**
   * Employment blocks, by id.
   *
   * A bullet may legitimately name the employer, the job title, and the dates
   * of the experience it belongs to: that is structured data the user imported
   * and reviewed, and it is printed as the section heading anyway. Without it,
   * validation rejects "Staff engineer at Acme since 2019" as invention — which
   * a live run against a real model produced immediately.
   *
   * Only experiences reachable from a cited fact count, so a claim still cannot
   * borrow one employer's name while citing another's work.
   */
  experiences?: Map<string, { company: string; role: string; startedOn?: string | undefined; endedOn?: string | undefined }>;
}

/**
 * Validates one bullet against the facts it cites.
 *
 * Evidence is drawn only from the cited facts and their own employment block,
 * not from the whole store. A bullet citing one fact while quoting a number
 * from another is a bullet whose citation is wrong, and provenance that points
 * at the wrong sentence is worth no more than none at all.
 */
export function validateClaim(
  claim: ClaimInput,
  factsById: Map<string, Fact>,
  options: ValidateOptions = {},
): ValidatedClaim {
  const problems: ClaimProblem[] = [];
  const text = claim.text.trim();
  const cited: Fact[] = [];

  if (claim.factIds.length === 0) {
    problems.push({ code: 'no-citation', detail: 'the bullet cites no fact' });
  }

  for (const id of claim.factIds) {
    const fact = factsById.get(id);

    if (!fact) {
      problems.push({ code: 'unknown-fact', detail: `cites "${id}", which is not a fact in the store` });
      continue;
    }

    if (fact.status !== 'approved' || fact.retiredAt !== undefined) {
      problems.push({ code: 'unapproved-fact', detail: `cites "${id}", which is not approved` });
      continue;
    }

    cited.push(fact);
  }

  if (text.length > MAX_CLAIM_CHARS) {
    problems.push({ code: 'too-long', detail: `${text.length} characters; the limit is ${MAX_CLAIM_CHARS}` });
  }

  const evidenceParts = cited.map((fact) => fact.statement);

  for (const fact of cited) {
    const experience = fact.experienceId ? options.experiences?.get(fact.experienceId) : undefined;
    if (!experience) continue;

    evidenceParts.push(
      [experience.role, experience.company, experience.startedOn, experience.endedOn]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' '),
    );
  }

  const evidence = evidenceParts.join(' \u2022 ');
  const evidenceNumbers = new Set(numbersIn(evidence));
  const evidenceTerms = new Set(namedTermsIn(evidence, false));

  for (const value of new Set(numbersIn(text))) {
    if (!evidenceNumbers.has(value)) {
      problems.push({ code: 'invented-number', detail: `"${value}" does not appear in the cited facts` });
    }
  }

  for (const term of namedTermsIn(text, true)) {
    if (!evidenceTerms.has(term)) {
      problems.push({ code: 'invented-term', detail: `"${term}" does not appear in the cited facts` });
    }
  }

  return { text, factIds: claim.factIds, supported: problems.length === 0, problems };
}

export function validateClaims(claims: ClaimInput[], facts: Fact[], options: ValidateOptions = {}): ValidatedClaim[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return claims.map((claim) => validateClaim(claim, byId, options));
}

export function describeProblems(claim: ValidatedClaim): string {
  return claim.problems.map((problem) => `${problem.code}: ${problem.detail}`).join('; ');
}
