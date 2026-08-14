import { z } from 'zod';
import type { ArchetypeConfig } from '../config/archetype-schema.js';
import type { Experience, Fact } from '../db/repositories/facts.js';
import type { FactMatch } from './matcher.js';

/**
 * What the model is allowed to produce for a resume.
 *
 * Narrow on purpose. The structure — which employers exist, in what order, with
 * what dates — comes from the fact store, and the headline comes from the
 * archetype the user wrote. The model's entire job is to phrase and order the
 * user's own approved statements for one kind of role.
 *
 * Every text it writes must cite the fact IDs it rests on, which is what makes
 * validation possible at all.
 */

const citedText = z.object({
  text: z.string().min(10).max(320),
  fact_ids: z.array(z.string().max(60)).max(6).default([]),
});

export const resumeSchema = z
  .object({
    summary: citedText,
    sections: z
      .array(
        z.object({
          experience_id: z.string().max(60),
          bullets: z.array(citedText).max(8),
        }),
      )
      .max(12),
    /** Facts the model chose not to use, and why. Reported, never acted on. */
    omitted: z.array(z.string().max(200)).max(10).default([]),
  })
  .strict();

export type TailoredResume = z.infer<typeof resumeSchema>;

export interface ResumeInputs {
  archetype: ArchetypeConfig;
  experiences: Experience[];
  /** Approved facts, ranked for this archetype, grouped by experience id. */
  matches: FactMatch[];
  profileText: string;
}

function factLine(fact: Fact): string {
  const tags = fact.tags.length > 0 ? ` [${fact.tags.join(', ')}]` : '';
  return `- id: ${fact.id}${tags}\n  ${fact.statement}`;
}

/**
 * Builds the tailoring prompt.
 *
 * No fence appears here, and that is deliberate rather than an omission: every
 * input is the user's own text or their own configuration. Posting text never
 * reaches this prompt — the per-application delta is a separate call, and it
 * fences what it quotes.
 */
export function buildResumePrompt(inputs: ResumeInputs): { system: string; prompt: string } {
  const { archetype, experiences, matches } = inputs;
  const byExperience = new Map<string, FactMatch[]>();
  const loose: FactMatch[] = [];

  for (const match of matches) {
    const id = match.fact.experienceId;
    if (id === undefined) {
      loose.push(match);
      continue;
    }
    byExperience.set(id, [...(byExperience.get(id) ?? []), match]);
  }

  const blocks = experiences
    .filter((experience) => (byExperience.get(experience.id) ?? []).length > 0)
    .map((experience) => {
      const dates = [experience.startedOn, experience.endedOn].filter(Boolean).join(' – ');
      const facts = (byExperience.get(experience.id) ?? []).map((match) => factLine(match.fact)).join('\n');
      return `EXPERIENCE id: ${experience.id}\n${experience.role}, ${experience.company}${dates ? ` (${dates})` : ''}\n${facts}`;
    });

  if (loose.length > 0) {
    blocks.push(`UNATTACHED FACTS (usable in the summary only)\n${loose.map((match) => factLine(match.fact)).join('\n')}`);
  }

  return {
    system: `You tailor a resume for one kind of role, using only statements the candidate has already approved.

Rules you must follow exactly:
- Every bullet and the summary must rest on the approved statements given to you, and must list the fact ids it uses in fact_ids.
- You may reword, shorten, combine and reorder. You may not add a number, a
  percentage, a technology, a company, a title, or a scope that is not present
  in the facts you cite. Rewording that changes magnitude is inventing.
- If the facts do not support something the role would want, leave it out and
  name it in "omitted". Do not compensate with vaguer wording.
- Use the experience_id values exactly as given. Do not invent sections.
- Reply with a single JSON object and nothing else.`,
    prompt: `Tailor this candidate's approved facts for the archetype below.

ARCHETYPE
${archetype.label}${archetype.focus ? `\nFocus: ${archetype.focus}` : ''}${archetype.skills.length > 0 ? `\nCentral skills: ${archetype.skills.join(', ')}` : ''}

CANDIDATE PROFILE (context only; not a source of claims)
${inputs.profileText.length > 0 ? inputs.profileText.slice(0, 4000) : '(none provided)'}

APPROVED FACTS
${blocks.join('\n\n')}`,
  };
}

/** Tokens the prompt will cost, for the dry run. */
export function estimateTokens(bundle: { system: string; prompt: string }): number {
  return Math.round((bundle.system.length + bundle.prompt.length) / 4);
}
