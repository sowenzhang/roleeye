import type { ArchetypeConfig, ArchetypesConfig } from '../config/archetype-schema.js';
import { canonicalize } from '../evaluate/criteria.js';
import type { ExtractedRequirements } from '../evaluate/schemas.js';
import { ROLE_FAMILIES } from '../portal/presets.js';
import { sha256 } from '../util/hash.js';

/**
 * Assigning a posting to a role archetype.
 *
 * This runs over every eligible posting, so it makes no model calls. A model
 * per posting is exactly the per-posting cost that archetypes exist to avoid,
 * and the question here — "which of the user's five buckets is this?" — is one
 * the user has already answered by writing the buckets down.
 *
 * The inputs are free too: the title, and the requirements Phase 3b already
 * extracted and stored. Nothing is re-read and nothing is re-sent.
 */

export interface ClassificationInput {
  title: string;
  descriptionText?: string | undefined;
  requirements?: ExtractedRequirements | undefined;
}

export interface ArchetypeScore {
  archetypeId: string;
  score: number;
  evidence: string[];
}

export interface ClassificationResult {
  /** Undefined means unassigned, which is a legitimate outcome. */
  archetypeId: string | undefined;
  score: number;
  runnerUpId: string | undefined;
  runnerUpScore: number | undefined;
  evidence: string[];
  reason: 'assigned' | 'below-threshold' | 'tie' | 'no-archetypes';
  all: ArchetypeScore[];
}

/**
 * Content hash of the archetype definitions.
 *
 * A generated resume is only current while the archetype that produced it is
 * unchanged, and assignments are only current while the set is unchanged. Both
 * are keyed on this rather than on a version field somebody has to remember to
 * bump.
 */
export function archetypesHash(config: ArchetypesConfig): string {
  return sha256(JSON.stringify(canonicalize({ archetypes: config.archetypes, classification: config.classification })));
}

export function findArchetype(config: ArchetypesConfig, id: string): ArchetypeConfig | undefined {
  return config.archetypes.find((archetype) => archetype.id === id);
}

/**
 * Starting points drawn from the role families the portal already offers.
 *
 * Seeded, not generated: the user still decides how many resumes they are
 * willing to maintain. `focus` is left empty because only they know what their
 * version of "infrastructure" emphasises.
 */
export function seedArchetypes(familyIds: string[]): ArchetypeConfig[] {
  return ROLE_FAMILIES.filter((family) => familyIds.includes(family.id)).map((family) => ({
    id: family.id,
    label: family.label,
    titles: [...family.titles],
    excludes: [...family.excludes],
    skills: [],
    focus: '',
    fact_tags: [],
  }));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Terms the posting offers up for skill matching, from structure first. */
function skillTerms(input: ClassificationInput): string[] {
  const requirements = input.requirements;

  if (requirements) {
    return [...requirements.required_skills, ...requirements.preferred_skills, ...requirements.domain].map(normalize);
  }

  // No extraction yet: the body is a weaker but honest substitute. It is only
  // ever searched for the archetype's own terms, never mined for new ones.
  const body = normalize(input.descriptionText ?? '');
  return body.length > 0 ? [body] : [];
}

function containsTerm(haystack: string, term: string): boolean {
  if (term.length === 0) return false;

  // Word-boundary matching, so "ios" does not match "curiosity" and "ml" does
  // not match "html". Terms may be phrases, so the boundary is applied to the
  // whole phrase rather than each word.
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * Score one archetype against one posting.
 *
 * Weighting: the title is the stronger signal because it is what the employer
 * chose to call the job, and skills alone describe adjacent roles equally well
 * — a payments backend role and an infrastructure role list the same tools.
 */
export function scoreArchetype(input: ClassificationInput, archetype: ArchetypeConfig): ArchetypeScore {
  const title = normalize(input.title);
  const evidence: string[] = [];

  const excluded = archetype.excludes.find((term) => containsTerm(title, term));
  if (excluded) {
    return { archetypeId: archetype.id, score: 0, evidence: [`title matches exclusion "${excluded}"`] };
  }

  const titleHits = archetype.titles.filter((term) => containsTerm(title, term));
  const titleScore = titleHits.length > 0 ? 1 : 0;
  if (titleHits.length > 0) evidence.push(`title matches ${titleHits.map((hit) => `"${hit}"`).join(', ')}`);

  const terms = skillTerms(input);
  const skillHits = archetype.skills.filter((skill) => terms.some((term) => containsTerm(term, skill)));

  // Divided by a small expectation rather than by the full list: an archetype
  // listing twenty skills should not need all twenty to be recognised.
  const skillScore = archetype.skills.length === 0 ? 0 : Math.min(1, skillHits.length / Math.min(4, archetype.skills.length));
  if (skillHits.length > 0) evidence.push(`skills: ${skillHits.slice(0, 6).join(', ')}`);

  return {
    archetypeId: archetype.id,
    score: Number((0.6 * titleScore + 0.4 * skillScore).toFixed(4)),
    evidence,
  };
}

export function classify(input: ClassificationInput, config: ArchetypesConfig): ClassificationResult {
  if (config.archetypes.length === 0) {
    return {
      archetypeId: undefined,
      score: 0,
      runnerUpId: undefined,
      runnerUpScore: undefined,
      evidence: [],
      reason: 'no-archetypes',
      all: [],
    };
  }

  const scored = config.archetypes
    .map((archetype) => scoreArchetype(input, archetype))
    // Ties broken by id, so the same corpus classifies the same way twice.
    .sort((a, b) => b.score - a.score || a.archetypeId.localeCompare(b.archetypeId));

  const best = scored[0] as ArchetypeScore;
  const runnerUp = scored[1];
  const { min_score: minScore, min_margin: minMargin } = config.classification;

  const base = {
    score: best.score,
    runnerUpId: runnerUp?.archetypeId,
    runnerUpScore: runnerUp?.score,
    evidence: best.evidence,
    all: scored,
  };

  if (best.score < minScore) {
    return { ...base, archetypeId: undefined, reason: 'below-threshold' };
  }

  if (runnerUp && best.score - runnerUp.score < minMargin) {
    return { ...base, archetypeId: undefined, reason: 'tie' };
  }

  return { ...base, archetypeId: best.archetypeId, reason: 'assigned' };
}
