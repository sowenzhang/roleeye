import type { AppConfig } from '../config/load.js';
import type { SourceConfig } from '../config/schema.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AnswerLookup, AnswerRepository } from '../db/repositories/answers.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import type { SourcePosting } from '../db/repositories/source-postings.js';
import type { HttpClient } from '../discovery/source-adapter.js';
import { htmlToText, normalizeInlineText, truncate } from '../normalize/text.js';
import { errorMessage } from '../util/errors.js';

/**
 * Form inspection: what does this application ask that the resume does not
 * already say?
 *
 * The point of the feature is the *residue*. Name, email, phone and the resume
 * upload are answered by the documents RoleEye already produces; what costs the
 * user an evening is the twelve free-text boxes underneath them, which are
 * mostly the same twelve boxes as the last employer's. So the report separates
 * the two and matches only the residue against the answer bank.
 *
 * Coverage is deliberately narrow and honest. Greenhouse publishes the question
 * set for a posting through its public board API; Lever and Ashby publish the
 * posting and not the form (verified against both live APIs on 2026-08-14).
 * Rendering an apply page in a browser to read its inputs would produce a
 * confident guess about what an employer asks, and a wrong record is worse than
 * a missing one — the same rule the career-page adapter follows. Unsupported
 * providers say so and name the URL to open.
 *
 * Nothing here submits anything. It reads a form and reports.
 */

export type QuestionKind = 'identity' | 'document' | 'demographic' | 'question';

export interface FormQuestion {
  label: string;
  description: string | undefined;
  required: boolean;
  kind: QuestionKind;
  /** Provider field names, kept so a repeat inspection can be compared. */
  fields: string[];
  type: string;
  options: string[];
}

export interface InspectedQuestion extends FormQuestion {
  lookup: AnswerLookup;
}

export interface FormInspection {
  jobId: string;
  provider: string;
  supported: boolean;
  /** Where the form lives, so an unsupported provider is still actionable. */
  url: string | undefined;
  /** Questions the resume and profile already answer. */
  covered: FormQuestion[];
  /** Everything else — the part that costs the user time. */
  questions: InspectedQuestion[];
  /**
   * Voluntary self-identification. Reported so the user knows it is there,
   * never matched against the bank and never stored: EEO questionnaires are
   * asked per application by design, and reusing one is not this tool's
   * business.
   */
  demographic: FormQuestion[];
  note: string | undefined;
  error: string | undefined;
}

/** Greenhouse's own field names for the parts a resume already carries. */
const RESUME_FIELDS = new Set([
  'first_name',
  'last_name',
  'preferred_name',
  'email',
  'phone',
  'resume',
  'resume_text',
  'cover_letter',
  'cover_letter_text',
  'full_name',
  'name',
  'location',
  'auto_complete_location',
]);

const DEMOGRAPHIC_FIELDS = /^(gender|race|veteran|disability|hispanic|ethnic|demographic)/i;

/**
 * Self-identification detected from the question itself.
 *
 * Field names are not enough. A voluntary "What is your sexual orientation?"
 * added as an ordinary custom question arrives as `question_14826587008`, which
 * matches nothing, and would then be looked up in the bank and stored — the two
 * things this category must never do.
 */
const DEMOGRAPHIC_LABELS =
  /\bgender\b|\bsexual\s+orientation\b|\bgender\s+identity\b|\bpronouns?\b|\brace\b|\bracial\b|\bethnic\w*\b|\bnational\s+origin\b|\bancestry\b|\bveterans?\b|\bdisabilit\w*\b|\bdisabled\b|\bself-?identif\w*\b|\beeoc?\b|\bhispanic\b|\blatin[ox]\b|\breligio\w+\b|\bmarital\s+status\b|\bdate\s+of\s+birth\b/i;

/**
 * Storage bound for a question. Generous, because the key and the sensitivity
 * check must see the whole question: truncating to a display width first lets
 * an employer hide "do you require visa sponsorship" past the cut and have it
 * treated as an ordinary question. Display truncation belongs to the caller.
 */
const MAX_LABEL = 1_000;
const MAX_DESCRIPTION = 1_000;
const MAX_OPTIONS = 12;
const MAX_QUESTIONS = 100;

interface GreenhouseField {
  name?: string;
  type?: string;
  values?: Array<{ label?: string; value?: unknown }>;
}

interface GreenhouseQuestion {
  label?: string;
  description?: string | null;
  required?: boolean;
  fields?: GreenhouseField[];
}

/** The self-identification block has its own shape: no `fields`, and `answer_options`. */
interface GreenhouseDemographicQuestion {
  label?: string;
  required?: boolean;
  type?: string;
  answer_options?: Array<{ label?: string }>;
}

export interface GreenhouseJobWithQuestions {
  id?: number | string;
  questions?: GreenhouseQuestion[];
  compliance?: Array<{ type?: string; questions?: GreenhouseQuestion[] }> | null;
  demographic_questions?: { header?: string; questions?: GreenhouseDemographicQuestion[] } | null;
}

function classify(fields: string[], label: string, description: string): QuestionKind {
  if (fields.some((name) => DEMOGRAPHIC_FIELDS.test(name))) return 'demographic';
  if (DEMOGRAPHIC_LABELS.test(label) || DEMOGRAPHIC_LABELS.test(description)) return 'demographic';
  if (fields.some((name) => name === 'resume' || name === 'cover_letter')) return 'document';
  if (fields.length > 0 && fields.every((name) => RESUME_FIELDS.has(name))) return 'identity';
  return 'question';
}

/** Employer-written text is untrusted: markup is stripped, not decoded in place. */
function clean(value: string | null | undefined, max: number): string {
  return truncate(normalizeInlineText(htmlToText(value ?? '')), max);
}

function mapQuestion(question: GreenhouseQuestion, force?: QuestionKind): FormQuestion[] {
  const label = clean(question.label, MAX_LABEL);
  if (!label) return [];

  const rawFields = asArray(question.fields);

  const fields = rawFields
    .map((field) => normalizeInlineText(field?.name ?? ''))
    .filter((name) => name.length > 0);

  const description = clean(question.description, MAX_DESCRIPTION);

  const options = rawFields
    .flatMap((field) => asArray(field?.values))
    .map((value) => clean(String(value?.label ?? ''), MAX_LABEL))
    .filter((value) => value.length > 0)
    .slice(0, MAX_OPTIONS);

  return [
    {
      label,
      description: description ? description : undefined,
      required: question.required === true,
      kind: force ?? classify(fields, label, description),
      fields,
      type: normalizeInlineText(rawFields[0]?.type ?? 'unknown'),
      options,
    },
  ];
}

function mapDemographic(question: GreenhouseDemographicQuestion): FormQuestion[] {
  const label = clean(question.label, MAX_LABEL);
  if (!label) return [];

  return [
    {
      label,
      description: undefined,
      required: question.required === true,
      kind: 'demographic',
      fields: [],
      type: normalizeInlineText(question.type ?? 'unknown'),
      options: asArray(question.answer_options)
        .map((option) => clean(option?.label, MAX_LABEL))
        .filter((value) => value.length > 0)
        .slice(0, MAX_OPTIONS),
    },
  ];
}

/**
 * Pure mapping from the board payload to questions, so the parser is tested
 * from fixtures with no network.
 *
 * Three blocks carry questions and only two of them share a shape: `questions`
 * and `compliance[].questions` use `fields`, while `demographic_questions`
 * carries `answer_options` and no fields at all. Both real shapes were read off
 * live boards rather than inferred, because the compliance block is the one
 * holding disability and veteran status — the answers this product must never
 * guess.
 */
export function parseGreenhouseQuestions(payload: GreenhouseJobWithQuestions): FormQuestion[] {
  const standard = asArray(payload.questions).slice(0, MAX_QUESTIONS).flatMap((question) => mapQuestion(question));

  const compliance = asArray(payload.compliance)
    .flatMap((entry) => asArray(entry?.questions))
    .slice(0, MAX_QUESTIONS)
    .flatMap((question) => mapQuestion(question, 'demographic'));

  const demographic = asArray(payload.demographic_questions?.questions)
    .slice(0, MAX_QUESTIONS)
    .flatMap((question) => mapDemographic(question));

  return [...standard, ...compliance, ...demographic];
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value.filter((entry) => entry !== null && entry !== undefined) : [];
}

/**
 * A minimum shape check before anything is read.
 *
 * The board is a third party that can change its response, and an unreadable
 * payload must be reported as unreadable rather than as a form with no
 * questions.
 */
export function isQuestionPayload(value: unknown): value is GreenhouseJobWithQuestions {
  if (typeof value !== 'object' || value === null) return false;

  const payload = value as Record<string, unknown>;
  const holders = [payload['questions'], payload['compliance'], (payload['demographic_questions'] as Record<string, unknown> | null | undefined)?.['questions']];

  return holders.some((entry) => Array.isArray(entry));
}

/** `board` comes from configuration when we have it, and from the URL when we do not. */
export interface GreenhouseTarget {
  board: string;
  jobId: string;
}

const BOARD_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const JOB_ID = /^\d{1,20}$/;

/**
 * Reads a board *and* a job id from one URL, or reads neither.
 *
 * Deriving them separately was a real defect: a posting URL is
 * attacker-influenced, so pairing a board taken from configuration with a
 * number scraped off the end of some other URL's path would return a different
 * role's questions under this role's name. The two halves of an identity have
 * to come from the same place.
 *
 * Three shapes are recognised, all Greenhouse-hosted:
 * `boards.greenhouse.io/{board}/jobs/{id}`,
 * `job-boards.greenhouse.io/{board}/jobs/{id}`, and the embed form
 * `boards.greenhouse.io/embed/job_app?for={board}&token={id}`.
 */
export function greenhouseTargetFromUrl(url: string | undefined): GreenhouseTarget | undefined {
  if (!url) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (!/(^|\.)greenhouse\.io$/i.test(parsed.hostname)) return undefined;

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);

  if (segments[0] === 'embed') {
    const board = parsed.searchParams.get('for') ?? '';
    const token = parsed.searchParams.get('token') ?? parsed.searchParams.get('gh_jid') ?? '';
    return BOARD_TOKEN.test(board) && JOB_ID.test(token) ? { board, jobId: token } : undefined;
  }

  const [board, jobs, jobId] = segments;
  if (!board || jobs !== 'jobs' || !jobId) return undefined;

  return BOARD_TOKEN.test(board) && JOB_ID.test(jobId) ? { board, jobId } : undefined;
}

/** Only a Greenhouse-issued id counts: `gh_jid`, or the id the board API gave us. */
function greenhouseIdFromQuery(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const value = new URL(url).searchParams.get('gh_jid') ?? '';
    return JOB_ID.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function questionsUrl(board: string, jobId: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}?questions=true`;
}

export type TargetResolution =
  | { kind: 'resolved'; target: GreenhouseTarget }
  | { kind: 'conflict'; configured: string; found: string }
  | { kind: 'unknown' };

/**
 * Works out which board and posting to ask about.
 *
 * A URL that carries both wins, and a configured board that disagrees with it
 * is a conflict rather than a tie-break: a posting claiming to be on somebody
 * else's board is a fact worth reporting, not one to paper over. Configuration
 * supplies the board only when the id came from the provider itself — either
 * the board API's own `source_job_id`, or a `gh_jid` query parameter, which
 * only Greenhouse issues.
 */
export function resolveGreenhouseTarget(
  posting: SourcePosting,
  sources: readonly SourceConfig[],
): TargetResolution {
  const configured = sources.find(
    (source): source is Extract<SourceConfig, { type: 'greenhouse' }> =>
      source.type === 'greenhouse' && source.name === posting.sourceName,
  )?.board;

  for (const candidate of [posting.applyUrl, posting.canonicalUrl, posting.sourceUrl]) {
    const target = greenhouseTargetFromUrl(candidate);
    if (!target) continue;
    if (configured && configured.toLowerCase() !== target.board.toLowerCase()) {
      return { kind: 'conflict', configured, found: target.board };
    }
    return { kind: 'resolved', target };
  }

  if (!configured) return { kind: 'unknown' };

  const providerId =
    posting.sourceJobId && JOB_ID.test(posting.sourceJobId)
      ? posting.sourceJobId
      : (greenhouseIdFromQuery(posting.applyUrl) ??
        greenhouseIdFromQuery(posting.canonicalUrl) ??
        greenhouseIdFromQuery(posting.sourceUrl));

  return providerId ? { kind: 'resolved', target: { board: configured, jobId: providerId } } : { kind: 'unknown' };
}

function formUrl(posting: SourcePosting | undefined): string | undefined {
  return posting?.applyUrl ?? posting?.canonicalUrl ?? posting?.sourceUrl;
}

export interface InspectFormOptions {
  job: JobRecord;
  repos: Repositories;
  config: AppConfig;
  http: HttpClient;
}

/**
 * Reads the application form for a role and matches it against the bank.
 *
 * A protected question is never answered from a similar-looking previous one;
 * `AnswerRepository.lookup` enforces that, and this function does not second
 * guess it.
 */
export async function inspectForm(options: InspectFormOptions): Promise<FormInspection> {
  const { job, repos, config, http } = options;

  const postings = repos.postings.listForJob(job.id);
  const greenhouse = postings.find((posting) => posting.sourceType === 'greenhouse');
  const posting = greenhouse ?? postings[0];

  const base: FormInspection = {
    jobId: job.id,
    provider: posting?.sourceType ?? 'unknown',
    supported: false,
    url: formUrl(posting),
    covered: [],
    questions: [],
    demographic: [],
    note: undefined,
    error: undefined,
  };

  if (!posting) {
    return { ...base, note: 'no source posting is recorded for this role' };
  }

  if (!greenhouse) {
    return {
      ...base,
      note: `${posting.sourceType} does not publish its application form; open the URL to see what it asks`,
    };
  }

  const resolution = resolveGreenhouseTarget(greenhouse, config.sources.sources);

  if (resolution.kind === 'conflict') {
    return {
      ...base,
      provider: 'greenhouse',
      note:
        `this posting's URL names board "${resolution.found}" while the source is configured as ` +
        `"${resolution.configured}"; refusing to ask one board about the other's posting`,
    };
  }

  if (resolution.kind === 'unknown') {
    return {
      ...base,
      provider: 'greenhouse',
      note: 'this posting is advertised through Greenhouse but does not name a board and job id we can query',
    };
  }

  const { board, jobId } = resolution.target;

  let payload: unknown;
  try {
    payload = await http.getJson<unknown>(questionsUrl(board, jobId));
  } catch (error) {
    return {
      ...base,
      provider: 'greenhouse',
      error: errorMessage(error),
      note: 'the board did not return this posting; employers who apply through their own site are common',
    };
  }

  // A payload that does not carry a question list is an unreadable form, not an
  // empty one. Reporting "this application asks nothing" because a provider
  // changed its response shape would be the most misleading output available.
  if (!isQuestionPayload(payload)) {
    return {
      ...base,
      provider: 'greenhouse',
      error: 'the board returned a payload with no question list',
      note: 'the form could not be read; open the URL to see what it asks',
    };
  }

  let parsed: FormQuestion[];
  try {
    parsed = parseGreenhouseQuestions(payload);
  } catch (error) {
    return {
      ...base,
      provider: 'greenhouse',
      error: errorMessage(error),
      note: 'the board returned a question list this version cannot read',
    };
  }

  if (parsed.length === 0) {
    return {
      ...base,
      provider: 'greenhouse',
      supported: true,
      note: 'the board published no questions for this posting',
    };
  }

  const covered = parsed.filter((question) => question.kind === 'identity' || question.kind === 'document');
  const demographic = parsed.filter((question) => question.kind === 'demographic');
  const rest = parsed.filter((question) => question.kind === 'question');

  return {
    ...base,
    provider: 'greenhouse',
    supported: true,
    covered,
    demographic,
    questions: rest.map((question) => ({
      ...question,
      lookup: repos.answers.lookup(question.label, { employer: job.companyName, role: job.id }),
    })),
  };
}

export interface SaveQuestionsResult {
  created: number;
  existing: number;
}

/**
 * Stores the unanswered questions so the user fills each one once.
 *
 * Placeholders are written with no answer, which is the honest state: the form
 * asked, and nothing has been said yet. A protected question is stored the same
 * way and stays unanswered until a human types the answer. Self-identification
 * questions are not stored at all — they are not in `questions`.
 */
export function saveQuestions(answers: AnswerRepository, inspection: FormInspection): SaveQuestionsResult {
  let created = 0;
  let existing = 0;

  for (const question of inspection.questions) {
    // Defensive: `questions` never holds self-identification, and this is the
    // line that would have to fail before one was written down.
    if (question.kind === 'demographic') continue;

    const result = answers.ensurePlaceholder(question.label);
    if (result.created) created += 1;
    else existing += 1;
  }

  return { created, existing };
}
