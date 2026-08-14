import path from 'node:path';
import type { AppConfig } from '../config/load.js';
import type { ArchetypeConfig } from '../config/archetype-schema.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Fact } from '../db/repositories/facts.js';
import type { ResumeGeneration } from '../db/repositories/resumes.js';
import { loadCareerProfile } from '../evaluate/profile.js';
import type { ReasoningProvider } from '../reasoning/provider.js';
import { ExitCode, RoleEyeError, errorMessage } from '../util/errors.js';
import { sha256 } from '../util/hash.js';
import type { Logger } from '../util/logger.js';
import { nowIso } from '../util/time.js';
import { findArchetype } from './archetypes.js';
import { factsForArchetype } from './matcher.js';
import { renderDocx, renderMarkdown, renderProvenance, loadResumeHeader, writeText } from './render.js';
import { buildResumePrompt, estimateTokens, resumeSchema, type TailoredResume } from './tailor.js';
import { validateClaims, type ValidatedClaim } from './validate.js';

/**
 * Generating one resume for one archetype.
 *
 * The cost model of the whole product lives in this file's caller, not here:
 * this runs once per archetype, not once per posting, and only when one of its
 * inputs has changed. Everything that makes that safe — the input hashes, the
 * approval requirement, claim validation — is enforced below rather than being
 * left to whoever calls it.
 */

export const MINIMUM_FACTS = 3;

export interface GenerationInputs {
  archetype: ArchetypeConfig;
  archetypeHash: string;
  factSetHash: string;
  profileHash: string;
}

export interface GenerateResult {
  outcome: 'generated' | 'current';
  generation: ResumeGeneration;
  dropped: ValidatedClaim[];
  artifacts: string[];
  costUsd: number;
}

export interface GeneratorOptions {
  config: AppConfig;
  repos: Repositories;
  provider: ReasoningProvider | undefined;
  logger: Logger;
}

/** Everything a generation depends on, hashed. */
export function generationInputs(config: AppConfig, repos: Repositories, archetypeId: string): GenerationInputs {
  const archetype = findArchetype(config.archetypes, archetypeId);

  if (!archetype) {
    const known = config.archetypes.archetypes.map((entry) => entry.id).join(', ') || '(none defined)';
    throw new RoleEyeError(
      `no archetype "${archetypeId}" in config/archetypes.yaml. Defined: ${known}`,
      ExitCode.ConfigError,
    );
  }

  return {
    archetype,
    // The single archetype rather than the whole file: adding a second
    // archetype must not invalidate the resume for the first.
    archetypeHash: sha256(JSON.stringify(archetype)),
    factSetHash: repos.facts.approvedSetHash(),
    profileHash: loadCareerProfile(config.env.paths.profileDir).hash,
  };
}

export function isStale(generation: ResumeGeneration, inputs: GenerationInputs): boolean {
  return (
    generation.archetypeHash !== inputs.archetypeHash ||
    generation.factSetHash !== inputs.factSetHash ||
    generation.profileHash !== inputs.profileHash
  );
}

export class ResumeGenerator {
  constructor(private readonly options: GeneratorOptions) {}

  /** The prompt that would be sent, for `--dry-run`. */
  describe(archetypeId: string): { system: string; prompt: string; estimatedTokens: number; facts: number } {
    const { config, repos } = this.options;
    const inputs = generationInputs(config, repos, archetypeId);
    const approved = repos.facts.approvedFacts();
    const matches = factsForArchetype(approved, inputs.archetype);
    const bundle = buildResumePrompt({
      archetype: inputs.archetype,
      experiences: repos.facts.listExperiences(),
      matches,
      profileText: loadCareerProfile(config.env.paths.profileDir).text,
    });

    return { ...bundle, estimatedTokens: estimateTokens(bundle), facts: matches.length };
  }

  async generate(archetypeId: string, options: { force?: boolean } = {}): Promise<GenerateResult> {
    const { config, repos, logger, provider } = this.options;
    const inputs = generationInputs(config, repos, archetypeId);

    const existing = repos.resumes.current(archetypeId);
    if (existing && !isStale(existing, inputs) && !options.force) {
      return { outcome: 'current', generation: existing, dropped: [], artifacts: [], costUsd: 0 };
    }

    const approved = repos.facts.approvedFacts();
    if (approved.length < MINIMUM_FACTS) {
      throw new RoleEyeError(
        `only ${approved.length} approved fact(s). Import a resume with \`roleeye resume import\` and approve facts with \`roleeye resume approve\` before generating.`,
        ExitCode.UsageError,
      );
    }

    if (!provider) {
      throw new RoleEyeError(
        'no reasoning provider configured. Set reasoning.provider in config/criteria.yaml, or run `roleeye ui` to pick one.',
        ExitCode.ConfigError,
      );
    }

    const profile = loadCareerProfile(config.env.paths.profileDir);
    const experiences = repos.facts.listExperiences();
    const matches = factsForArchetype(approved, inputs.archetype);
    const bundle = buildResumePrompt({
      archetype: inputs.archetype,
      experiences,
      matches,
      profileText: profile.text,
    });

    const started = nowIso();
    let document: TailoredResume;
    let cost = 0;
    let model = provider.model;

    try {
      const envelope = await provider.generate<TailoredResume>({
        stage: 'resume',
        system: bundle.system,
        prompt: bundle.prompt,
        schema: resumeSchema,
        schemaName: 'resume',
        maxOutputTokens: config.criteria.reasoning.max_output_tokens,
      });

      document = envelope.data;
      cost = envelope.usage.estimatedCostUsd ?? 0;
      model = envelope.model;

      repos.llmCalls.record({
        jobId: undefined,
        evaluationId: undefined,
        stage: 'resume',
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
    } catch (error) {
      repos.llmCalls.record({
        jobId: undefined,
        evaluationId: undefined,
        stage: 'resume',
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

      throw error;
    }

    const knownExperiences = new Map(experiences.map((experience) => [experience.id, experience]));
    const validateOptions = { experiences: knownExperiences };
    const dropped: ValidatedClaim[] = [];
    const claims: { section: string; position: number; text: string; factIds: string[]; supported: boolean; problems: string[] }[] = [];

    const summaryValidation = validateClaims(
      [{ text: document.summary.text, factIds: document.summary.fact_ids }],
      approved,
      validateOptions,
    )[0] as ValidatedClaim;
    if (!summaryValidation.supported) dropped.push(summaryValidation);

    claims.push({
      section: 'summary',
      position: 0,
      text: summaryValidation.text,
      factIds: summaryValidation.factIds,
      supported: summaryValidation.supported,
      problems: summaryValidation.problems.map((problem) => `${problem.code}: ${problem.detail}`),
    });

    const supportedText = new Set<string>();

    for (const section of document.sections) {
      if (!knownExperiences.has(section.experience_id)) {
        // The model named a section we did not give it. Dropped rather than
        // rendered, because a heading with no employer behind it is fiction.
        logger.warn('generated section names an unknown experience; dropped', {
          experienceId: section.experience_id,
        });
        continue;
      }

      const validated = validateClaims(
        section.bullets.map((bullet) => ({ text: bullet.text, factIds: bullet.fact_ids })),
        approved,
        validateOptions,
      );

      validated.forEach((claim, index) => {
        if (!claim.supported) dropped.push(claim);
        else supportedText.add(`${section.experience_id}\u0000${claim.text.trim()}`);

        claims.push({
          section: section.experience_id,
          position: index,
          text: claim.text,
          factIds: claim.factIds,
          supported: claim.supported,
          problems: claim.problems.map((problem) => `${problem.code}: ${problem.detail}`),
        });
      });
    }

    if (dropped.length > 0) {
      logger.warn('dropped unsupported claims before writing the resume', {
        dropped: dropped.length,
        first: dropped[0]?.problems[0]?.detail,
      });
    }

    const generation = repos.resumes.save({
      archetypeId,
      archetypeHash: inputs.archetypeHash,
      factSetHash: inputs.factSetHash,
      profileHash: inputs.profileHash,
      provider: provider.name,
      model,
      headline: inputs.archetype.label,
      summary: summaryValidation.supported ? summaryValidation.text : '',
      document,
      validated: dropped.length === 0,
      claims,
    });

    const artifacts = await this.write(generation, document, {
      archetype: inputs.archetype,
      experiences: knownExperiences,
      approved,
      supportedSummary: summaryValidation.supported,
      supportedText,
    });

    return { outcome: 'generated', generation, dropped, artifacts, costUsd: cost };
  }

  /** Writes the documents. Only supported claims are ever rendered. */
  private async write(
    generation: ResumeGeneration,
    document: TailoredResume,
    context: {
      archetype: ArchetypeConfig;
      experiences: Map<string, { id: string; company: string; role: string; startedOn: string | undefined; endedOn: string | undefined; slug: string; sortOrder: number }>;
      approved: Fact[];
      supportedSummary: boolean;
      supportedText: Set<string>;
    },
  ): Promise<string[]> {
    const { config, repos } = this.options;
    const directory = path.join(config.env.paths.artifactsDir, 'archetypes', context.archetype.id);
    const statements = new Map(context.approved.map((fact) => [fact.id, fact.statement]));

    const renderInputs = {
      header: loadResumeHeader(config.env.paths.profileDir),
      archetypeLabel: context.archetype.label,
      document: {
        ...document,
        summary: context.supportedSummary ? document.summary : { text: '', fact_ids: [] },
      },
      experiences: context.experiences,
      supported: (bullet: { text: string; fact_ids: string[] }, experienceId: string): boolean =>
        context.supportedText.has(`${experienceId}\u0000${bullet.text.trim()}`),
    };

    const markdown = writeText(path.join(directory, 'resume.md'), renderMarkdown(renderInputs));
    const provenance = writeText(
      path.join(directory, 'resume-provenance.md'),
      renderProvenance(renderInputs, (id) => statements.get(id)),
    );

    const docxPath = path.join(directory, 'resume.docx');
    const docxBuffer = await renderDocx(renderInputs, docxPath);

    const record = (file: string, type: string, checksum: string): void => {
      repos.artifacts.record({
        generationId: generation.id,
        archetypeId: context.archetype.id,
        type,
        path: file,
        checksum,
        contentHash: generation.factSetHash,
        metadata: { model: generation.model, provider: generation.provider },
      });
    };

    record(markdown.path, 'resume-md', markdown.checksum);
    record(provenance.path, 'resume-provenance', provenance.checksum);
    record(docxPath, 'resume-docx', sha256(docxBuffer.toString('base64')));

    return [markdown.path, provenance.path, docxPath];
  }
}
