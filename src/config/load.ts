import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { ConfigError } from '../util/errors.js';
import { criteriaSchema, sourceSchema, sourcesSchema, syncSchema } from './schema.js';
import { archetypesSchema, type ArchetypesConfig } from './archetype-schema.js';
import type { CriteriaConfig, SourcesConfig, SyncConfig } from './schema.js';
import { catalogEntryToSource, catalogKey, selectCatalog } from '../discovery/catalog.js';
import { loadDotEnv, resolveEnvironment, type Environment } from './paths.js';

export interface AppConfig {
  env: Environment;
  criteria: CriteriaConfig;
  sources: SourcesConfig;
  sync: SyncConfig;
  archetypes: ArchetypesConfig;
  loadedFiles: string[];
  missingFiles: string[];
}

export interface LoadOptions {
  root: string;
  /** When true, missing YAML files fall back to schema defaults instead of failing. */
  allowDefaults?: boolean;
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => `  - ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
}

function readYamlFile<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`unable to read ${path.basename(file)}`, {
      file,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw) ?? {};
  } catch (error) {
    throw new ConfigError(`invalid YAML in ${path.basename(file)}`, {
      file,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`invalid configuration in ${path.basename(file)}:\n${formatIssues(result.error.issues)}`, {
      file,
    });
  }

  return result.data;
}

function loadSection<T>(
  configDir: string,
  fileName: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  allowDefaults: boolean,
  loaded: string[],
  missing: string[],
): T {
  const file = path.join(configDir, fileName);

  if (existsSync(file)) {
    loaded.push(file);
    return readYamlFile(file, schema);
  }

  missing.push(file);

  if (!allowDefaults) {
    const example = fileName.replace(/\.yaml$/, '.example.yaml');
    throw new ConfigError(
      `missing ${fileName}. Copy config/${example} to config/${fileName} and edit it.`,
      { file },
    );
  }

  const result = schema.safeParse({});
  if (!result.success) {
    throw new ConfigError(`no defaults available for ${fileName}:\n${formatIssues(result.error.issues)}`, { file });
  }
  return result.data;
}

/**
 * Loads environment and all YAML configuration.
 *
 * `allowDefaults` exists so `roleeye doctor` can report every problem at once
 * instead of failing on the first missing file.
 */
export function loadConfig(options: LoadOptions): AppConfig {
  const { root, allowDefaults = false } = options;

  loadDotEnv(root);
  const env = resolveEnvironment(root);

  const loadedFiles: string[] = [];
  const missingFiles: string[] = [];

  const criteria = loadSection(env.paths.configDir, 'criteria.yaml', criteriaSchema, allowDefaults, loadedFiles, missingFiles);
  const declared = loadSection(env.paths.configDir, 'sources.yaml', sourcesSchema, allowDefaults, loadedFiles, missingFiles);
  const sources = { ...declared, sources: resolveSources(declared) };
  const sync = loadSection(env.paths.configDir, 'sync.yaml', syncSchema, true, loadedFiles, missingFiles);

  // Always defaulted: an empty archetype list is a valid state, and it is the
  // state everyone is in before they reach Phase 4.
  const archetypes = loadSection(
    env.paths.configDir,
    'archetypes.yaml',
    archetypesSchema,
    true,
    loadedFiles,
    missingFiles,
  );

  return { env, criteria, sources, sync, archetypes, loadedFiles, missingFiles };
}

export function enabledSources(config: AppConfig): SourcesConfig['sources'] {
  return config.sources.sources.filter((source) => source.enabled);
}

/**
 * The boards a scan will actually read.
 *
 * `sources.yaml` holds two things: boards written down by name — a company
 * added by URL, or one hand-edited in — and a rule describing the kind of
 * company to watch. Everything downstream wants one list, and wants it to mean
 * the same thing whether it came from a name or a rule, so they are combined
 * here, once, at load.
 *
 * Resolving at load rather than at save is the point. A materialised list is a
 * snapshot of the catalog on the day someone pressed save; a rule keeps
 * matching as the catalog grows, which is what "watch companies like this"
 * means to the person who asked for it.
 */
export function resolveSources(declared: SourcesConfig): SourcesConfig['sources'] {
  const rule = declared.discovery.companies;
  const written = declared.sources;

  // A board named explicitly wins: it may carry per-source scope or capture
  // overrides that a catalog entry knows nothing about.
  const seen = new Set(
    written.map((source) => catalogKey({ type: source.type, token: sourceToken(source) })),
  );
  const excluded = new Set(rule.exclude.map((key) => key.toLowerCase()));

  const fromRule = selectCatalog(rule)
    .filter((entry) => !seen.has(catalogKey(entry)))
    .map((entry) => sourceSchema.parse(catalogEntryToSource(entry)));

  return [...written.filter((source) => !excluded.has(catalogKey({ type: source.type, token: sourceToken(source) }))), ...fromRule];
}

function sourceToken(source: SourcesConfig['sources'][number]): string {
  if ('board' in source) return source.board;
  if ('site' in source) return source.site;
  return source.url;
}

export type { CriteriaConfig, SourcesConfig, SyncConfig };
export type { ArchetypesConfig, ArchetypeConfig } from './archetype-schema.js';
export type { SourceConfig } from './schema.js';
