import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { z } from 'zod';
import { criteriaSchema, sourcesSchema } from '../config/schema.js';
import type { Paths } from '../config/paths.js';

/**
 * Reading and writing configuration for the portal.
 *
 * The portal is a client, not a second implementation: it writes the same YAML
 * files the CLI reads, through the same zod schemas the loader validates with.
 * Nothing is written unless it would load.
 */

export interface ConfigDocument<T> {
  path: string;
  exists: boolean;
  /** False when the file on disk does not satisfy the schema. */
  valid: boolean;
  /** Why it is invalid, so the portal can say so rather than quietly replacing it. */
  problems: ValidationProblem[];
  value: T;
}

export interface ValidationProblem {
  path: string;
  message: string;
}

export type SaveResult<T> =
  | { ok: true; value: T; path: string }
  | { ok: false; problems: ValidationProblem[] };

function issuesOf(error: z.ZodError): ValidationProblem[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

function read<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): ConfigDocument<T> {
  if (!existsSync(file)) {
    // A first run has no files yet; defaults let the portal open on something.
    return { path: file, exists: false, valid: true, problems: [], value: schema.parse({}) };
  }

  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8')) ?? {};
  } catch (error) {
    // Malformed YAML is a user typo, not a portal failure. Report it like any
    // other problem so the page still opens and explains itself.
    return {
      path: file,
      exists: true,
      valid: false,
      problems: [{ path: '(file)', message: error instanceof Error ? error.message.split('\n')[0]! : String(error) }],
      value: schema.parse({}),
    };
  }

  const result = schema.safeParse(raw);

  // A file the loader would reject still has to be openable, or the portal
  // becomes useless exactly when it is most needed. It is shown as defaults,
  // but reported as invalid so nobody overwrites real settings unknowingly.
  return {
    path: file,
    exists: true,
    valid: result.success,
    problems: result.success ? [] : issuesOf(result.error),
    value: result.success ? result.data : schema.parse({}),
  };
}

function save<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, candidate: unknown): SaveResult<T> {
  const result = schema.safeParse(candidate);
  if (!result.success) return { ok: false, problems: issuesOf(result.error) };

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, stringify(result.data, { lineWidth: 100 }));

  return { ok: true, value: result.data, path: file };
}

export class ConfigService {
  private readonly criteriaFile: string;
  private readonly sourcesFile: string;

  constructor(private readonly paths: Paths) {
    this.criteriaFile = path.join(paths.configDir, 'criteria.yaml');
    this.sourcesFile = path.join(paths.configDir, 'sources.yaml');
  }

  readCriteria(): ConfigDocument<z.infer<typeof criteriaSchema>> {
    return read(this.criteriaFile, criteriaSchema);
  }

  readSources(): ConfigDocument<z.infer<typeof sourcesSchema>> {
    return read(this.sourcesFile, sourcesSchema);
  }

  saveCriteria(candidate: unknown): SaveResult<z.infer<typeof criteriaSchema>> {
    return save(this.criteriaFile, criteriaSchema, candidate);
  }

  saveSources(candidate: unknown): SaveResult<z.infer<typeof sourcesSchema>> {
    return save(this.sourcesFile, sourcesSchema, candidate);
  }

  /** Where the files live, so the portal can tell the user what it changed. */
  locations(): { criteria: string; sources: string; database: string } {
    return { criteria: this.criteriaFile, sources: this.sourcesFile, database: this.paths.dbPath };
  }
}
