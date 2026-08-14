import path from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../config/load.js';
import type { Repositories } from '../db/repositories/index.js';
import type { JobRecord } from '../db/repositories/jobs.js';
import type { Fact } from '../db/repositories/facts.js';
import type { ResumeClaim } from '../db/repositories/resumes.js';
import { fenceUntrusted, UNTRUSTED_SAFETY } from '../evaluate/prompts.js';
import type { ExtractedRequirements } from '../evaluate/schemas.js';
import type { ReasoningProvider } from '../reasoning/provider.js';
import { ExitCode, RoleEyeError, errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { nowIso } from '../util/time.js';
import { findArchetype } from './archetypes.js';
import { storedRequirements } from './assign.js';
import { rankFacts } from './matcher.js';
import { writeText } from './render.js';
import { validateClaims, type ValidatedClaim } from './validate.js';

/**
 * The per-application delta.
 *
 * Produced on APPLY and only on APPLY (docs/vision.md §7). Generating a
 * document for every discovered role costs a hundred times more and produces
 * documents nobody sends; generating one when the user has decided to apply is
 * eight documents for eight applications.
 *
 * The delta is deliberately small: a headline the user already wrote, their own
 * bullets reordered for this role, and one short note. Everything except the
 * note is deterministic, because reordering is a ranking problem and ranking is
 * not something to pay a model for.
 */

const deltaSchema = z
  .object({
    cover_note: z.object({
      text: z.string().min(20).max(900),
      fact_ids: z.array(z.string().max(60)).max(6).default([]),
    }),
    embedded_instructions: z
      .object({ found: z.boolean(), quote: z.string().max(300).optional() })
      .default({ found: false }),
  })
  .strict();

export type ApplicationDelta = z.infer<typeof deltaSchema>;

export interface DeltaResult {
  jobId: string;
  archetypeId: string;
  headline: string;
  orderedClaims: ResumeClaim[];
  coverNote: ValidatedClaim | undefined;
  artifacts: string[];
  costUsd: number;
}

/**
 * The headline for this application.
 *
 * Chosen from the archetype's own title terms, never composed: a headline is a
 * claim about what the candidate is, and inventing one to match a requisition
 * is how a resume starts describing somebody else.
 */
export function chooseHeadline(jobTitle: string, titles: string[], fallback: string): string {
  const title = jobTitle.toLowerCase();
  const matches = titles
    .filter((term) => title.includes(term))
    .sort((a, b) => b.length - a.length);

  const chosen = matches[0];
  if (!chosen) return fallback;

  return chosen.replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

/** Claims reordered so the ones this posting asks about come first. */
export function orderClaimsForRole(
  claims: ResumeClaim[],
  requirements: ExtractedRequirements | undefined,
  facts: Fact[],
): ResumeClaim[] {
  if (!requirements) return claims;

  const terms = [...requirements.required_skills, ...requirements.preferred_skills, ...requirements.domain];
  const ranked = rankFacts(facts, terms, facts.length);

  const factScore = new Map(ranked.map((match) => [match.fact.id, match.score]));
  const score = (claim: ResumeClaim): number =>
    Math.max(0, ...claim.factIds.map((id) => factScore.get(id) ?? 0));

  // Sorted within a section only. Moving a bullet between employers would
  // rewrite history rather than re-emphasise it.
  const bySection = new Map<string, ResumeClaim[]>();
  for (const claim of claims) {
    bySection.set(claim.section, [...(bySection.get(claim.section) ?? []), claim]);
  }

  const ordered: ResumeClaim[] = [];
  for (const [, section] of bySection) {
    ordered.push(...[...section].sort((a, b) => score(b) - score(a) || a.position - b.position));
  }

  return ordered;
}

export interface DeltaOptions {
  config: AppConfig;
  repos: Repositories;
  provider: ReasoningProvider | undefined;
  logger: Logger;
  job: JobRecord;
  force?: boolean;
}

export async function buildDelta(options: DeltaOptions): Promise<DeltaResult> {
  const { config, repos, provider, logger, job } = options;

  const evaluation = repos.evaluations.latestForJob(job.id);
  if (!evaluation && !options.force) {
    throw new RoleEyeError(
      `${job.id} has not been evaluated. Run \`roleeye evaluate\` first, or pass --force.`,
      ExitCode.UsageError,
    );
  }

  if (evaluation && evaluation.decision !== 'APPLY' && !options.force) {
    throw new RoleEyeError(
      `${job.id} was decided "${evaluation.decision}", not APPLY. Deltas are written when you decide to apply; pass --force to override.`,
      ExitCode.UsageError,
    );
  }

  const assignment = repos.assignments.latestForJob(job.id);
  const archetypeId = assignment?.archetypeId;

  if (!archetypeId) {
    throw new RoleEyeError(
      `${job.id} is not assigned to an archetype. Run \`roleeye resume classify\`, or assign it with \`roleeye resume assign ${job.id} <archetype>\`.`,
      ExitCode.UsageError,
    );
  }

  const archetype = findArchetype(config.archetypes, archetypeId);
  if (!archetype) {
    throw new RoleEyeError(`archetype "${archetypeId}" is no longer defined in config/archetypes.yaml`, ExitCode.ConfigError);
  }

  const generation = repos.resumes.current(archetypeId);
  if (!generation) {
    throw new RoleEyeError(
      `no resume has been generated for "${archetypeId}". Run \`roleeye resume generate ${archetypeId}\`.`,
      ExitCode.UsageError,
    );
  }

  const approved = repos.facts.approvedFacts();
  const claims = repos.resumes.claims(generation.id).filter((claim) => claim.supported && claim.section !== 'summary');
  const requirements = storedRequirements(repos, job.id);
  const ordered = orderClaimsForRole(claims, requirements, approved);
  const headline = chooseHeadline(job.title, archetype.titles, archetype.label);

  let coverNote: ValidatedClaim | undefined;
  let cost = 0;

  if (provider) {
    const started = nowIso();

    try {
      const envelope = await provider.generate<ApplicationDelta>({
        stage: 'delta',
        system: `You write a short note explaining why a candidate is applying for one specific role.

Use only the approved statements provided. Never introduce a number, technology,
employer or title that is not in them, and list the fact ids you used.
Three or four sentences. No greeting, no sign-off, no flattery.
${UNTRUSTED_SAFETY}`,
        prompt: `Write the note for this application.

CANDIDATE'S APPROVED STATEMENTS
${approved
  .slice(0, 40)
  .map((fact) => `- id: ${fact.id}\n  ${fact.statement}`)
  .join('\n')}

TARGET ARCHETYPE
${archetype.label}${archetype.focus ? `\nFocus: ${archetype.focus}` : ''}

${fenceUntrusted(
  `ROLE\nCompany: ${job.companyName.replace(/\s+/g, ' ').slice(0, 120)}\nTitle: ${job.title.replace(/\s+/g, ' ').slice(0, 160)}\n\nREQUIREMENTS (a model's reading of the posting)\n${JSON.stringify(requirements ?? {}, null, 2)}`,
)}`,
        schema: deltaSchema,
        schemaName: 'delta',
        maxOutputTokens: config.criteria.reasoning.max_output_tokens,
      });

      cost = envelope.usage.estimatedCostUsd ?? 0;

      repos.llmCalls.record({
        jobId: job.id,
        evaluationId: undefined,
        stage: 'delta',
        provider: envelope.provider,
        model: envelope.model,
        inputTokens: envelope.usage.inputTokens,
        outputTokens: envelope.usage.outputTokens,
        estimatedCostUsd: envelope.usage.estimatedCostUsd,
        requestCount: envelope.usage.requestCount,
        cacheHit: false,
        succeeded: true,
        error: undefined,
        createdAt: started,
      });

      if (envelope.data.embedded_instructions.found) {
        logger.warn('posting contains text aimed at an automated reader', {
          jobId: job.id,
          quote: envelope.data.embedded_instructions.quote?.slice(0, 120),
        });
      }

      const validated = validateClaims(
        [{ text: envelope.data.cover_note.text, factIds: envelope.data.cover_note.fact_ids }],
        approved,
        { experiences: new Map(repos.facts.listExperiences().map((entry) => [entry.id, entry])) },
      )[0] as ValidatedClaim;

      coverNote = validated;

      if (!validated.supported) {
        logger.warn('the cover note made claims the approved facts do not support; it was not written out', {
          jobId: job.id,
          problems: validated.problems.map((problem) => problem.code).join(', '),
        });
      }
    } catch (error) {
      repos.llmCalls.record({
        jobId: job.id,
        evaluationId: undefined,
        stage: 'delta',
        provider: provider.name,
        model: provider.model,
        inputTokens: undefined,
        outputTokens: undefined,
        estimatedCostUsd: undefined,
        requestCount: 1,
        cacheHit: false,
        succeeded: false,
        error: errorMessage(error),
        createdAt: started,
      });

      logger.warn('cover note generation failed; writing the delta without it', {
        jobId: job.id,
        error: errorMessage(error),
      });
    }
  }

  const directory = path.join(
    config.env.paths.artifactsDir,
    job.companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown-company',
    job.id,
  );

  const statements = new Map(approved.map((fact) => [fact.id, fact.statement]));
  const lines: string[] = [
    `# Application delta — ${job.title}`,
    '',
    `Company: ${job.companyName}`,
    `Archetype: ${archetype.label} (\`${archetype.id}\`)`,
    `Base resume: generation ${generation.id}`,
    '',
    '## Headline',
    '',
    headline,
    '',
    '## Lead with these',
    '',
  ];

  for (const claim of ordered.slice(0, 6)) {
    lines.push(`- ${claim.text}`);
    for (const id of claim.factIds) lines.push(`  - from \`${id}\`: ${statements.get(id) ?? '(fact not found)'}`);
  }

  lines.push('', '## Note', '');

  if (coverNote?.supported) {
    lines.push(coverNote.text);
  } else if (coverNote) {
    lines.push(
      '_No note was written: the generated one made claims the approved facts do not support._',
      '',
      ...coverNote.problems.map((problem) => `- ${problem.code}: ${problem.detail}`),
    );
  } else {
    lines.push('_No reasoning provider configured, so no note was generated._');
  }

  const written = writeText(path.join(directory, 'resume-delta.md'), `${lines.join('\n').trim()}\n`);

  repos.artifacts.record({
    jobId: job.id,
    generationId: generation.id,
    archetypeId: archetype.id,
    snapshotId: evaluation?.snapshotId,
    type: 'resume-delta',
    path: written.path,
    checksum: written.checksum,
    contentHash: job.descriptionHash,
    metadata: { headline, claims: ordered.length },
  });

  return {
    jobId: job.id,
    archetypeId,
    headline,
    orderedClaims: ordered,
    coverNote,
    artifacts: [written.path],
    costUsd: cost,
  };
}
