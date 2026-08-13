import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { ConfigError } from '../util/errors.js';
import { criteriaSchema, sourcesSchema, syncSchema } from './schema.js';
import type { CriteriaConfig, SourcesConfig, SyncConfig } from './schema.js';
import { loadDotEnv, resolveEnvironment, type Environment } from './paths.js';

export interface AppConfig {
  env: Environment;
  criteria: CriteriaConfig;
  sources: SourcesConfig;
  sync: SyncConfig;
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
  const sources = loadSection(env.paths.configDir, 'sources.yaml', sourcesSchema, allowDefaults, loadedFiles, missingFiles);
  const sync = loadSection(env.paths.configDir, 'sync.yaml', syncSchema, true, loadedFiles, missingFiles);

  return { env, criteria, sources, sync, loadedFiles, missingFiles };
}

export function enabledSources(config: AppConfig): SourcesConfig['sources'] {
  return config.sources.sources.filter((source) => source.enabled);
}

export type { CriteriaConfig, SourcesConfig, SyncConfig };
export type { SourceConfig } from './schema.js';
