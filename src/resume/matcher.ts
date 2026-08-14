import type { Fact } from '../db/repositories/facts.js';
import type { ArchetypeConfig } from '../config/archetype-schema.js';
import type { ExtractedRequirements } from '../evaluate/schemas.js';

/**
 * Matching facts to what a role asks for.
 *
 * Deterministic, and used twice: to choose which approved facts an archetype
 * resume is built from, and to decide which of its bullets to lead with for a
 * particular posting. Both are ranking problems over the user's own sentences,
 * which needs no model and must be reproducible.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'over', 'across', 'per', 'via',
  'was', 'were', 'are', 'has', 'had', 'have', 'our', 'their', 'its', 'his', 'her', 'they', 'them',
  'a', 'an', 'of', 'to', 'in', 'on', 'by', 'at', 'as', 'is', 'it', 'be', 'or', 'we', 'us',
  'built', 'led', 'work', 'working', 'worked', 'team', 'teams', 'new', 'using', 'used', 'use',
  'role', 'years', 'year', 'experience', 'strong', 'ability', 'including', 'etc',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((token) => token.replace(/^[.]+|[.]+$/g, ''))
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token) && !/^\d+$/.test(token));
}

export interface FactMatch {
  fact: Fact;
  score: number;
  matched: string[];
}
/**
 * Ranks facts by overlap with a set of terms.
 *
 * Overlap is counted on distinct matched terms rather than total hits, so a
 * fact repeating one keyword five times does not outrank a fact covering five
 * of the role's requirements.
 */
export function rankFacts(facts: Fact[], terms: string[], limit = 40): FactMatch[] {
  const wanted = new Set(terms.flatMap((term) => tokenize(term)));

  const scored = facts.map((fact) => {
    const tokens = new Set([...tokenize(fact.statement), ...fact.tags.flatMap((tag) => tokenize(tag))]);
    const matched = [...wanted].filter((term) => tokens.has(term));

    return {
      fact,
      // Normalised by the number of terms asked for, so scores stay comparable
      // between a role listing four requirements and one listing twenty.
      score: wanted.size === 0 ? 0 : Number((matched.length / wanted.size).toFixed(4)),
      matched,
    };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.fact.createdAt.localeCompare(b.fact.createdAt))
    .slice(0, limit);
}

/**
 * The fact set an archetype resume is generated from.
 *
 * Facts that match nothing are still included when there is room: a resume is
 * not only its keywords, and dropping every unmatched fact produces a document
 * with no career in it. Ordering is what the archetype changes.
 */
export function factsForArchetype(facts: Fact[], archetype: ArchetypeConfig, limit = 40): FactMatch[] {
  const terms = [...archetype.titles, ...archetype.skills, ...archetype.fact_tags, archetype.label];
  const tagged =
    archetype.fact_tags.length === 0
      ? facts
      : facts.filter(
          (fact) =>
            fact.tags.length === 0 || fact.tags.some((tag) => archetype.fact_tags.includes(tag.toLowerCase())),
        );

  return rankFacts(tagged, terms, limit);
}

export function factsForRequirements(
  facts: Fact[],
  requirements: ExtractedRequirements,
  limit = 12,
): FactMatch[] {
  const terms = [
    ...requirements.required_skills,
    ...requirements.preferred_skills,
    ...requirements.domain,
    requirements.primary_mission,
  ];

  return rankFacts(facts, terms, limit).filter((match) => match.score > 0);
}
