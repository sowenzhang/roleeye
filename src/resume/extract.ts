/**
 * Turning a resume into draft facts.
 *
 * Deterministic on purpose. A model could group and rewrite more elegantly, but
 * import runs before the user has approved anything, so a model here would be
 * inventing the very statements the approval step exists to check. Extraction
 * therefore only *finds* the user's own sentences; it never composes one.
 *
 * The other rule is that a wrong record is worse than a missing one. Where the
 * shape of a resume is genuinely ambiguous — which half of "Acme — Staff
 * Engineer" is the employer — nothing is guessed: the facts are imported
 * unattributed and the ambiguity is reported.
 */

export interface DraftExperience {
  company: string;
  role: string;
  startedOn: string | undefined;
  endedOn: string | undefined;
  sortOrder: number;
}

export interface DraftFact {
  statement: string;
  tags: string[];
  /** Index into the extracted experiences, when one could be identified. */
  experienceIndex: number | undefined;
}

export interface ExtractionResult {
  experiences: DraftExperience[];
  facts: DraftFact[];
  warnings: string[];
}

const MAX_FACTS = 300;
const MIN_STATEMENT_CHARS = 25;
const MAX_STATEMENT_CHARS = 400;

const SECTION_HEADINGS: ReadonlyArray<[RegExp, string]> = [
  [/^(work |professional |relevant )?experience$/i, 'experience'],
  [/^employment( history)?$/i, 'experience'],
  [/^education$/i, 'education'],
  [/^(technical )?skills$/i, 'skills'],
  [/^projects?$/i, 'projects'],
  [/^(certifications?|licenses?)$/i, 'certifications'],
  [/^(publications?|patents?)$/i, 'publications'],
  [/^(summary|profile|objective|about)$/i, 'summary'],
  [/^(awards?|honors?)$/i, 'awards'],
  [/^(volunteering|community)$/i, 'community'],
];

const BULLET = /^\s*([•▪◦‣∙·*\-–—]|\d{1,2}[.)])\s+/;

/** Month names and year ranges, in the forms resumes actually use. */
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE_PART = `((${MONTH}\\s+)?(19|20)\\d{2}|present|current|now)`;
const DATE_RANGE = new RegExp(`${DATE_PART}\\s*(–|—|-|to|until)\\s*${DATE_PART}`, 'i');

/**
 * Words that mark one side of a header line as the job title.
 *
 * Deliberately generic: this decides *which side is which*, not whether a role
 * is interesting, so a missing word costs an attribution, never a fact.
 */
const ROLE_WORDS =
  /\b(engineer|engineering|developer|architect|manager|director|lead|head|principal|staff|scientist|analyst|designer|consultant|specialist|administrator|founder|president|officer|intern|associate|partner|researcher|programmer|technician|advisor|owner)\b/i;

const SEPARATOR = /\s+[|·•–—]\s+|\s+[-]\s+|\s+\bat\b\s+|,\s+/;

const CONTACT = /(https?:\/\/|www\.|@[a-z0-9.-]+\.[a-z]{2,}|\b\d{3}[.\s-]?\d{3}[.\s-]?\d{4}\b)/i;

function isHeading(line: string): string | undefined {
  const text = line.trim().replace(/[:\s]+$/, '');
  if (text.length === 0 || text.length > 40) return undefined;

  for (const [pattern, label] of SECTION_HEADINGS) {
    if (pattern.test(text)) return label;
  }

  return undefined;
}

function extractDates(line: string): { startedOn: string | undefined; endedOn: string | undefined } {
  const match = DATE_RANGE.exec(line);
  if (!match) return { startedOn: undefined, endedOn: undefined };

  const [range] = match;
  const [rawStart, rawEnd] = range.split(/\s*(?:–|—|-|to|until)\s*/i);

  const clean = (value: string | undefined): string | undefined => {
    const text = value?.trim();
    return text && text.length > 0 ? text : undefined;
  };

  return { startedOn: clean(rawStart), endedOn: clean(rawEnd) };
}

/**
 * An employment header, if this line is unambiguously one.
 *
 * Requires a date range, because that is the only signal that reliably
 * separates "Acme Corp — Staff Engineer, 2019-2023" from a sentence.
 */
function parseExperienceHeader(
  line: string,
  sortOrder: number,
): { experience: DraftExperience; ambiguous: boolean } | undefined {
  const text = line.trim();
  if (text.length === 0 || text.length > 140 || BULLET.test(line)) return undefined;
  if (!DATE_RANGE.test(text)) return undefined;

  const dates = extractDates(text);
  const withoutDates = text
    .replace(DATE_RANGE, '')
    .replace(/[(),|]\s*$/, '')
    .replace(/^\s*[|,(-]\s*/, '')
    .replace(/\s*[(|]\s*$/, '')
    .trim();

  const parts = withoutDates
    .split(SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 1 && part.length < 90);

  if (parts.length === 0) return undefined;

  if (parts.length === 1) {
    // One side only: it names either the employer or the job, and picking
    // wrong would put the user's job title in the company column forever.
    return {
      experience: { company: parts[0] as string, role: '(unstated)', ...dates, sortOrder },
      ambiguous: true,
    };
  }

  const roleIndex = parts.findIndex((part) => ROLE_WORDS.test(part));
  if (roleIndex === -1) {
    return {
      experience: { company: parts[0] as string, role: parts[1] as string, ...dates, sortOrder },
      ambiguous: true,
    };
  }

  const role = parts[roleIndex] as string;
  const company = (parts.find((_, index) => index !== roleIndex) ?? '(unstated)') as string;

  return { experience: { company, role, ...dates, sortOrder }, ambiguous: false };
}

function isUsableStatement(text: string): boolean {
  if (text.length < MIN_STATEMENT_CHARS || text.length > MAX_STATEMENT_CHARS) return false;
  if (text.split(/\s+/).length < 4) return false;
  if (CONTACT.test(text)) return false;

  // A heading in title case is not a claim, and neither is a skills list.
  if (text === text.toUpperCase() && /[A-Z]/.test(text)) return false;

  return true;
}

function normalizeStatement(text: string): string {
  return text.replace(BULLET, '').replace(/\s+/g, ' ').trim();
}

/**
 * Extracts experiences and candidate statements from resume text.
 *
 * Only bullets become facts. Prose paragraphs in a resume are summaries and
 * headers, and turning them into approvable claims produces a store full of
 * "Results-driven engineer with a passion for scale" — sentences the user would
 * never put on a tailored resume and now has to reject one at a time.
 */
export function extractFacts(text: string): ExtractionResult {
  const lines = text.split('\n');
  const experiences: DraftExperience[] = [];
  const facts: DraftFact[] = [];
  const warnings: string[] = [];

  let section = 'summary';
  let currentExperience: number | undefined;
  let ambiguousHeaders = 0;
  let pending: string | undefined;
  let capped = false;

  const flush = (): void => {
    if (pending === undefined) return;

    const statement = normalizeStatement(pending);
    pending = undefined;

    if (!isUsableStatement(statement)) return;

    if (facts.length >= MAX_FACTS) {
      capped = true;
      return;
    }

    facts.push({
      statement,
      tags: section === 'experience' || section === 'summary' ? [] : [section],
      experienceIndex: section === 'experience' ? currentExperience : undefined,
    });
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flush();
      continue;
    }

    const heading = isHeading(trimmed);
    if (heading) {
      flush();
      section = heading;
      if (heading !== 'experience') currentExperience = undefined;
      continue;
    }

    const isBullet = BULLET.test(line);

    if (!isBullet) {
      const header = parseExperienceHeader(trimmed, experiences.length);
      if (header) {
        flush();
        experiences.push(header.experience);
        currentExperience = experiences.length - 1;
        if (header.ambiguous) ambiguousHeaders += 1;
        // A dated header means employment, even if the section heading was
        // missing entirely — plenty of resumes have no headings at all.
        section = 'experience';
        continue;
      }
    }

    if (isBullet) {
      flush();
      pending = trimmed;
      continue;
    }

    // A wrapped continuation of the bullet above: resumes wrap constantly, and
    // a half-sentence is not a fact anyone can approve.
    if (pending !== undefined && /^[a-z(]/.test(trimmed)) {
      pending = `${pending} ${trimmed}`;
      continue;
    }

    flush();
  }

  flush();

  if (facts.length === 0) {
    warnings.push(
      'no bulleted statements were found. Facts are read from bullet points; add them to the document, or write facts by hand with `roleeye resume add-fact`.',
    );
  }

  if (capped) warnings.push(`more than ${MAX_FACTS} statements found; the rest were ignored`);

  if (ambiguousHeaders > 0) {
    warnings.push(
      `${ambiguousHeaders} employment heading(s) could not be split into employer and job title with confidence. Check them with \`roleeye resume experiences\`.`,
    );
  }

  const unattributed = facts.filter((fact) => fact.experienceIndex === undefined && fact.tags.length === 0).length;
  if (unattributed > 0 && experiences.length > 0) {
    warnings.push(`${unattributed} statement(s) could not be attached to an employer.`);
  }

  return { experiences, facts, warnings };
}
