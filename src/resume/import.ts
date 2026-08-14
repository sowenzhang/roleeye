import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import type { Fact } from '../db/repositories/facts.js';
import { ExitCode, RoleEyeError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { EXTRACTOR_VERSION, readDocument, type ReadOptions } from './documents.js';
import { extractFacts } from './extract.js';

/**
 * Importing documents and YAML into the fact store.
 *
 * Everything imported arrives as a **draft**, without exception. That is the
 * rule the whole resume pipeline rests on: a generated claim traces to a fact a
 * human approved, so an import path that could produce approved facts would
 * quietly remove the human from the loop.
 *
 * It also means export → import is lossy by design. Approvals live in the
 * database and are restored from a backup (`roleeye backup`), not from a text
 * file anyone could have edited in between.
 */

const yamlFactSchema = z
  .object({
    id: z.string().max(120).optional(),
    statement: z.string().min(3).max(400),
    tags: z.array(z.string().max(60)).max(20).default([]),
    status: z.string().max(20).optional(),
  })
  .strict();

const yamlExperienceSchema = z
  .object({
    id: z.string().max(120).optional(),
    company: z.string().min(1).max(120),
    role: z.string().min(1).max(120).default('(unstated)'),
    started_on: z.string().max(40).optional(),
    ended_on: z.string().max(40).optional(),
    facts: z.array(yamlFactSchema).max(400).default([]),
  })
  .strict();

export const accomplishmentsSchema = z
  .object({
    experiences: z.array(yamlExperienceSchema).max(60).default([]),
    /** Facts that belong to no particular employer. */
    facts: z.array(yamlFactSchema).max(400).default([]),
  })
  .strict();

export interface ImportSummary {
  importId: string;
  format: string;
  sourcePath: string;
  created: number;
  updated: number;
  unchanged: number;
  experiences: number;
  warnings: string[];
}

export interface ImportOptions extends ReadOptions {
  repos: Repositories;
  logger: Logger;
  file: string;
}

function importYaml(
  text: string,
  file: string,
): { experiences: { company: string; role: string; startedOn?: string; endedOn?: string }[]; facts: { statement: string; tags: string[]; experienceIndex: number | undefined }[]; warnings: string[] } {
  let parsed: unknown;

  try {
    parsed = parseYaml(text) ?? {};
  } catch (error) {
    throw new RoleEyeError(`invalid YAML in ${path.basename(file)}`, ExitCode.UsageError, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const result = accomplishmentsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new RoleEyeError(`invalid accomplishments file:\n${issues}`, ExitCode.UsageError);
  }

  const warnings: string[] = [];
  const experiences = result.data.experiences.map((entry) => ({
    company: entry.company,
    role: entry.role,
    ...(entry.started_on === undefined ? {} : { startedOn: entry.started_on }),
    ...(entry.ended_on === undefined ? {} : { endedOn: entry.ended_on }),
  }));

  const facts: { statement: string; tags: string[]; experienceIndex: number | undefined }[] = [];
  let approvedInFile = 0;

  result.data.experiences.forEach((entry, index) => {
    for (const fact of entry.facts) {
      if (fact.status === 'approved') approvedInFile += 1;
      facts.push({ statement: fact.statement, tags: fact.tags, experienceIndex: index });
    }
  });

  for (const fact of result.data.facts) {
    if (fact.status === 'approved') approvedInFile += 1;
    facts.push({ statement: fact.statement, tags: fact.tags, experienceIndex: undefined });
  }

  if (approvedInFile > 0) {
    warnings.push(
      `${approvedInFile} fact(s) were marked approved in the file. Imported facts always arrive as drafts; approve them with \`roleeye resume approve\`.`,
    );
  }

  return { experiences, facts, warnings };
}

export async function importDocument(options: ImportOptions): Promise<ImportSummary> {
  const { repos, logger, file } = options;
  const document = await readDocument(file, options);

  const previous = repos.facts.listImports(50).find((entry) => entry.sourceSha256 === document.sha256);
  if (previous) {
    logger.info('this exact file was imported before; reconciling rather than duplicating', {
      importedAt: previous.createdAt,
    });
  }

  const extraction =
    document.format === 'yaml' ? importYaml(document.text, file) : extractFacts(document.text);

  const record = repos.facts.recordImport({
    sourcePath: path.resolve(file),
    sourceSha256: document.sha256,
    format: document.format,
    bytes: document.bytes,
    extractor: document.extractor,
    extractorVersion: EXTRACTOR_VERSION,
    factsCreated: 0,
    factsUpdated: 0,
    factsUnchanged: 0,
    warnings: [...document.warnings, ...extraction.warnings],
  });

  const experienceIds = extraction.experiences.map((entry, index) =>
    repos.facts.upsertExperience({
      company: entry.company,
      role: entry.role,
      startedOn: entry.startedOn,
      endedOn: entry.endedOn,
      sortOrder: index,
    }).id,
  );

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const fact of extraction.facts) {
    const experienceId =
      fact.experienceIndex === undefined ? undefined : experienceIds[fact.experienceIndex];

    const { outcome } = repos.facts.upsert({
      statement: fact.statement,
      tags: fact.tags,
      experienceId,
      importId: record.id,
      origin: 'import',
    });

    if (outcome === 'created') created += 1;
    else if (outcome === 'updated') updated += 1;
    else unchanged += 1;
  }

  const warnings = [...document.warnings, ...extraction.warnings];
  repos.facts.updateImportCounts(record.id, { created, updated, unchanged, warnings });

  return {
    importId: record.id,
    format: document.format,
    sourcePath: path.resolve(file),
    created,
    updated,
    unchanged,
    experiences: experienceIds.length,
    warnings,
  };
}

/** Writes the store back out, so the readable copy is never out of reach. */
export function exportFacts(repos: Repositories, file: string): { facts: number; experiences: number } {
  const experiences = repos.facts.listExperiences();
  const facts = repos.facts.list({});
  const byExperience = new Map<string, Fact[]>();
  const loose: Fact[] = [];

  for (const fact of facts) {
    if (fact.experienceId === undefined) {
      loose.push(fact);
      continue;
    }
    const bucket = byExperience.get(fact.experienceId) ?? [];
    bucket.push(fact);
    byExperience.set(fact.experienceId, bucket);
  }

  const shape = (fact: Fact): Record<string, unknown> => ({
    id: fact.id,
    statement: fact.statement,
    ...(fact.tags.length > 0 ? { tags: fact.tags } : {}),
    status: fact.status,
  });

  const document = {
    experiences: experiences.map((experience) => ({
      id: experience.slug,
      company: experience.company,
      role: experience.role,
      ...(experience.startedOn ? { started_on: experience.startedOn } : {}),
      ...(experience.endedOn ? { ended_on: experience.endedOn } : {}),
      facts: (byExperience.get(experience.id) ?? []).map(shape),
    })),
    ...(loose.length > 0 ? { facts: loose.map(shape) } : {}),
  };

  const header = [
    '# Exported from the RoleEye fact store.',
    '# The database is the store: re-importing this file creates drafts, and',
    '# approvals are restored from a backup, not from this file.',
    '',
  ].join('\n');

  writeFileSync(file, `${header}${stringifyYaml(document)}`, 'utf8');

  return { facts: facts.length, experiences: experiences.length };
}
