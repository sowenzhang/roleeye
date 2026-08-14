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
  code:
    | 'no-citation'
    | 'unknown-fact'
    | 'unapproved-fact'
    | 'invented-number'
    | 'invented-term'
    | 'unsupported-scope'
    | 'markup'
    | 'too-long';
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

/**
 * Text is compared in a normalised form.
 *
 * A review produced "Cut latency by ６０%" — full-width digits, which `\d` does
 * not match, so the invented number was invisible to the check. NFKC folds
 * those to ASCII. Digits are then matched by unicode property, so Arabic-Indic
 * and other numeral systems are caught too.
 */
function fold(text: string): string {
  return text.normalize('NFKC');
}

/** Digits, percentages, multipliers, and money, in any of the written forms. */
const NUMBERS = /\p{Nd}[\p{Nd},.]*\s*(%|percent|x|k|m|b|bn|million|billion|hours?|days?|weeks?|months?|years?)?/giu;

/** Magnitudes a resume states in words rather than figures. */
const WRITTEN_NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12', fifteen: '15', twenty: '20', thirty: '30',
  forty: '40', fifty: '50', sixty: '60', hundred: '100', thousand: '1000', dozen: '12',
  half: '0.5', double: '2x', doubled: '2x', tripled: '3x', quadrupled: '4x',
};

/**
 * Terms whose presence is a factual claim: named technologies and acronyms.
 *
 * Capitalisation mid-sentence and all-caps acronyms are the reliable signals.
 * Sentence-initial words are excluded because every bullet starts with one.
 */
const NAMED_TERM = /\b([A-Z][a-zA-Z0-9+#.]*[a-z][a-zA-Z0-9+#.]*|[A-Z]{2,}[0-9]*)\b/g;

/**
 * Technologies written in lower case, and names with digits or symbols.
 *
 * Capitalisation alone was not enough: a review showed "used kubernetes and
 * react" passing untouched, and a posting can instruct a model to write in
 * lower case. Shape catches k8s, c++, .net and gpt-4; the list catches the
 * common names that are ordinary-looking words.
 */
const TECH_SHAPE = /\b([a-z]+[0-9]+[a-z0-9]*|[a-z]+\+\+|\.[a-z]{2,}|[a-z]+#|[a-z]+\.[a-z]{2,})\b/gi;

const TECH_WORDS = new Set([
  'java', 'javascript', 'typescript', 'python', 'ruby', 'rust', 'golang', 'kotlin', 'swift', 'scala',
  'react', 'angular', 'vue', 'svelte', 'node', 'deno', 'django', 'flask', 'rails', 'spring',
  'kubernetes', 'docker', 'terraform', 'ansible', 'jenkins', 'kafka', 'rabbitmq', 'redis', 'postgres',
  'postgresql', 'mysql', 'mongodb', 'cassandra', 'elasticsearch', 'snowflake', 'databricks', 'hadoop',
  'spark', 'airflow', 'kubeflow', 'pytorch', 'tensorflow', 'keras', 'pandas', 'numpy', 'sklearn',
  'aws', 'azure', 'gcp', 'lambda', 'kinesis', 'bigquery', 'firebase', 'heroku', 'graphql', 'grpc',
  'linux', 'kubernetes', 'openshift', 'prometheus', 'grafana', 'datadog', 'splunk', 'kibana',
]);

/**
 * Scope and seniority language that a resume must not acquire in generation.
 *
 * These are the embellishments that carry no number and no product name, so
 * nothing else here would catch them: a team of three becomes "a large team",
 * and an engineer becomes an owner of company-wide strategy. Each is allowed
 * only if the cited facts say something equivalent.
 */
const SCOPE_CLAIMS = [
  /\b(large|big|huge|sizeable|substantial)\s+(team|org|organisation|organization|group)\b/i,
  /\b(company|org|organisation|organization|enterprise)[-\s]?wide\b/i,
  /\b(managed|led|ran|headed|directed|supervised)\s+(a|an|the)?\s*(team|org|organisation|organization|department|division|group)\b/i,
  /\b(chief|vp|vice president|head of|director of|principal|distinguished|staff)\b/i,
  /\b(owned|drove|set)\s+(the)?\s*(strategy|roadmap|vision|budget)\b/i,
  /\b(hired|fired|promoted|mentored)\s+\p{Nd}*\s*(engineers|people|reports|staff)\b/iu,
  /\b(first|only|sole|best|top|leading|world[-\s]?class)\b/i,
];

const MARKUP = /!?\[[^\]]*\]\([^)]*\)|<\/?[a-z][^>]*>|https?:\/\/|www\.|\bdata:|\bjavascript:/i;

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
  const folded = fold(text);
  const figures = (folded.match(NUMBERS) ?? []).map(normalizeNumber);
  const words = folded
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word in WRITTEN_NUMBERS)
    .map((word) => WRITTEN_NUMBERS[word] as string);

  return [...figures, ...words].filter((value) => value.length > 0);
}

function namedTermsIn(text: string, skipFirstWord: boolean): string[] {
  const folded = fold(text);

  // Only the capitalisation heuristic skips sentence openers, because every
  // sentence starts with a capital that says nothing about the content. A live
  // run produced "…platform work. Works in Go, TypeScript…", where "Works"
  // was read as an invented product name and the whole summary was dropped.
  //
  // The lexicon and shape rules do not depend on case, so they read the whole
  // claim — otherwise "Kubernetes powered the workloads" would walk through
  // the gap this exemption creates.
  const capitalised = skipFirstWord
    ? folded.replace(/(^|[.!?:;]\s+|\n)\p{Lu}[\p{L}\p{N}'’+.#-]*/gu, (match) => match.toLowerCase())
    : folded;

  const matches = [
    ...(capitalised.match(NAMED_TERM) ?? []),
    ...(folded.match(TECH_SHAPE) ?? []),
    ...folded
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((word) => TECH_WORDS.has(word)),
  ];

  return [...new Set(matches.map((term) => term.toUpperCase()))].filter(
    (term) => term.length > 1 && !COMMON_WORDS.has(term),
  );
}

const COMMON_WORDS = new Set([
  'I', 'A', 'AN', 'THE', 'AND', 'OR', 'FOR', 'WITH', 'TO', 'OF', 'IN', 'ON', 'AT', 'BY',
  'CI', 'CD', 'IT', 'US', 'UK', 'EU', 'API', 'APIS', 'UI', 'UX', 'QA', 'OKR', 'KPI', 'ROI',
]);

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

  // A resume bullet never legitimately contains a link, a tag, or a URL. A
  // posting that talks a model into emitting one turns a document the user
  // opens into a network request to whoever wrote the posting.
  const markup = MARKUP.exec(fold(text));
  if (markup) {
    problems.push({ code: 'markup', detail: `contains markup or a link ("${markup[0].slice(0, 40)}")` });
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

  // Scope and seniority carry no number and no product name, so nothing above
  // catches them: a team of three becomes "a large team" and an engineer
  // acquires company-wide ownership. Allowed only where the facts say the same.
  const foldedEvidence = fold(evidence);
  for (const pattern of SCOPE_CLAIMS) {
    const claimed = pattern.exec(fold(text));
    if (claimed && !pattern.test(foldedEvidence)) {
      problems.push({
        code: 'unsupported-scope',
        detail: `claims scope the cited facts do not state ("${claimed[0].slice(0, 40)}")`,
      });
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
