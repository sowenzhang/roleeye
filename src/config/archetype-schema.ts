import { z } from 'zod';

/**
 * Role archetypes.
 *
 * An archetype is a *kind* of role the user pursues — "AI platform
 * engineering", "payments backend", "engineering management" — not a posting.
 * Resumes are generated per archetype (docs/vision.md §7), so this file decides
 * how many resumes exist, which is why it is configuration the user owns rather
 * than something inferred from the corpus.
 *
 * It lives in YAML with a content-derived hash for the same reason criteria do:
 * editing an archetype must invalidate what was generated from it, and a
 * hand-maintained version field is a field people forget to bump.
 */

const term = z.string().min(2).max(80).transform((value) => value.trim().toLowerCase());

export const archetypeSchema = z
  .object({
    id: z
      .string()
      .min(2)
      .max(40)
      // The id names a directory under artifacts/ and a resume file. Model
      // output and posting text never reach it, but a hand-edited config can,
      // so the safe shape is enforced here rather than at every use.
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lower-case letters, digits and hyphens'),
    label: z.string().min(2).max(80),
    /** Title words that indicate this archetype. */
    titles: z.array(term).max(40).default([]),
    /** Titles that look similar and are a different job. */
    excludes: z.array(term).max(40).default([]),
    /** Skills and domains the archetype is built around. */
    skills: z.array(term).max(60).default([]),
    /** Free text shown to the model when the resume is generated. */
    focus: z.string().max(400).default(''),
    /** Tags selecting which approved facts this resume may draw on. */
    fact_tags: z.array(term).max(40).default([]),
  })
  .strict();

export type ArchetypeConfig = z.infer<typeof archetypeSchema>;

export const archetypesSchema = z
  .object({
    /**
     * Three to six is the working range (docs/vision.md §7). One archetype is
     * a generic resume; twenty is per-posting tailoring wearing a disguise. The
     * ceiling is a hard limit because it is the cost model; the floor is not,
     * because a user who has written only one so far is mid-setup.
     */
    archetypes: z.array(archetypeSchema).max(12).default([]),
    classification: z
      .object({
        /**
         * Below this, a posting is left unassigned rather than forced into the
         * nearest archetype. An unassigned pile is information — it usually
         * means an archetype is missing.
         */
        min_score: z.number().min(0).max(1).default(0.35),
        /**
         * How far the winner must be ahead of the runner-up. Two archetypes
         * scoring alike is a genuine tie, and guessing between them silently
         * sends the wrong resume.
         */
        min_margin: z.number().min(0).max(1).default(0.1),
        /** Ask the model to break ties. Off by default: classification is free. */
        model_tiebreak: z.boolean().default(false),
      })
      .strict()
      .default({ min_score: 0.35, min_margin: 0.1, model_tiebreak: false }),
  })
  .strict()
  // Two archetypes with one id would write two different resumes to the same
  // artifact path, and the second would silently replace the first.
  .superRefine((config, ctx) => {
    const seen = new Set<string>();

    config.archetypes.forEach((archetype, index) => {
      if (seen.has(archetype.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['archetypes', index, 'id'],
          message: `duplicate archetype id "${archetype.id}"`,
        });
      }
      seen.add(archetype.id);
    });
  });

export type ArchetypesConfig = z.infer<typeof archetypesSchema>;

/** Duplicate ids would make an artifact path ambiguous. */
export function duplicateArchetypeIds(config: { archetypes: { id: string }[] }): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const archetype of config.archetypes) {
    if (seen.has(archetype.id)) duplicates.add(archetype.id);
    seen.add(archetype.id);
  }

  return [...duplicates];
}
