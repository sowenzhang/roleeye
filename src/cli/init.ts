import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ExitCode, type ExitCodeValue } from '../util/errors.js';
import { openDatabase } from '../db/database.js';
import { resolvePaths } from '../config/paths.js';
import { criteriaSchema, sourcesSchema } from '../config/schema.js';
import { flagBool } from './args.js';
import { createPrompter } from './prompt.js';
import { buildCriteriaYaml, buildSourcesYaml, interview } from './setup.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

interface CopyPlan {
  from: string;
  to: string;
}

const CONFIG_FILES = ['criteria', 'sources', 'sync', 'archetypes'] as const;
const PROFILE_FILES: ReadonlyArray<readonly [string, string]> = [
  ['career-profile.example.md', 'career-profile.md'],
  ['accomplishments.example.yaml', 'accomplishments.yaml'],
  ['master-resume.example.md', 'master-resume.md'],
];

/**
 * Prepares a working copy from the committed examples. Never overwrites an
 * existing file: the user's real config and profile are their own data.
 */
export const initCommand: Command = {
  name: 'init',
  summary: 'Set up local config, profile files, and the database',
  usage: 'roleeye init [--interactive] [--force] [--json]',

  async run(context: CommandContext) {
    const paths = resolvePaths(context.root);
    const force = flagBool(context.args, 'force');

    if (flagBool(context.args, 'interactive')) {
      return runInteractive(context, paths, force);
    }

    return runFromExamples(context, paths, force);
  },
};

/**
 * A short interview that produces working configuration.
 *
 * Without this the first run is "read the docs, write YAML, hope", which is
 * where most self-hosted tools lose people before they see any value.
 */
async function runInteractive(
  context: CommandContext,
  paths: ReturnType<typeof resolvePaths>,
  force: boolean,
): Promise<ExitCodeValue> {
  const criteriaFile = path.join(paths.configDir, 'criteria.yaml');
  const sourcesFile = path.join(paths.configDir, 'sources.yaml');

  const blocking = [criteriaFile, sourcesFile].filter((file) => existsSync(file));
  if (blocking.length > 0 && !force) {
    printLine(context, 'Configuration already exists:');
    for (const file of blocking) printLine(context, `  ${path.relative(context.root, file)}`);
    printLine(context);
    printLine(context, 'Re-run with --force to replace it.');
    return ExitCode.Ok;
  }

  printLine(context, 'roleeye setup');
  printLine(context);
  printLine(context, 'A few questions, then RoleEye is ready to scan. Press enter to accept a default.');
  printLine(context);

  const prompter = createPrompter();
  let answers;
  try {
    answers = await interview(prompter);
  } finally {
    prompter.close();
  }

  const sourcesYaml = buildSourcesYaml(answers);
  const criteriaYaml = buildCriteriaYaml(answers);

  // Never write configuration the loader would then reject.
  const { parse } = await import('yaml');
  const sourcesCheck = sourcesSchema.safeParse(parse(sourcesYaml));
  const criteriaCheck = criteriaSchema.safeParse(parse(criteriaYaml));

  if (!sourcesCheck.success || !criteriaCheck.success) {
    context.logger.error('generated configuration failed validation', {
      sources: sourcesCheck.success ? 'ok' : sourcesCheck.error.issues[0]?.message,
      criteria: criteriaCheck.success ? 'ok' : criteriaCheck.error.issues[0]?.message,
    });
    return ExitCode.ConfigError;
  }

  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(sourcesFile, sourcesYaml);
  writeFileSync(criteriaFile, criteriaYaml);

  for (const dir of [paths.dataDir, paths.artifactsDir, paths.exportDir]) {
    mkdirSync(dir, { recursive: true });
  }
  openDatabase({ path: paths.dbPath, logger: context.logger }).close();

  printLine(context);
  printLine(context, `  wrote ${path.relative(context.root, sourcesFile)}`);
  printLine(context, `  wrote ${path.relative(context.root, criteriaFile)}`);
  printLine(context);

  if (answers.boards.length === 0) {
    printLine(context, 'No boards configured yet. Add one to config/sources.yaml, then run `roleeye scan`.');
  } else {
    printLine(context, 'Next:');
    printLine(context, '  roleeye scan            fetch the boards you listed');
    printLine(context, '  roleeye screen          filter them against your rules');
    printLine(context, '  roleeye schedule install --at 07:30');
  }

  return ExitCode.Ok;
}

function runFromExamples(
  context: CommandContext,
  paths: ReturnType<typeof resolvePaths>,
  force: boolean,
): ExitCodeValue {
    const plans: CopyPlan[] = [
      ...CONFIG_FILES.map((name) => ({
        from: path.join(paths.configDir, `${name}.example.yaml`),
        to: path.join(paths.configDir, `${name}.yaml`),
      })),
      ...PROFILE_FILES.map(([from, to]) => ({
        from: path.join(paths.profileDir, from),
        to: path.join(paths.profileDir, to),
      })),
    ];

    const created: string[] = [];
    const skipped: string[] = [];
    const missing: string[] = [];

    for (const plan of plans) {
      if (!existsSync(plan.from)) {
        missing.push(plan.from);
        continue;
      }
      if (existsSync(plan.to) && !force) {
        skipped.push(plan.to);
        continue;
      }
      mkdirSync(path.dirname(plan.to), { recursive: true });
      copyFileSync(plan.from, plan.to);
      created.push(plan.to);
    }

    const envExample = path.join(context.root, '.env.example');
    const envFile = path.join(context.root, '.env');
    if (existsSync(envExample) && !existsSync(envFile)) {
      copyFileSync(envExample, envFile);
      created.push(envFile);
    } else if (existsSync(envFile)) {
      skipped.push(envFile);
    }

    for (const dir of [paths.dataDir, paths.artifactsDir, paths.exportDir]) {
      mkdirSync(dir, { recursive: true });
    }

    const db = openDatabase({ path: paths.dbPath, logger: context.logger });
    db.close();

    if (context.json) {
      printJson(context, { created, skipped, missing, database: paths.dbPath });
      return ExitCode.Ok;
    }

    printLine(context, 'roleeye init');
    printLine(context);
    for (const file of created) printLine(context, `  created  ${path.relative(context.root, file)}`);
    for (const file of skipped) printLine(context, `  kept     ${path.relative(context.root, file)}`);
    for (const file of missing) printLine(context, `  missing  ${path.relative(context.root, file)}`);
    printLine(context);
    printLine(context, `  database ${path.relative(context.root, paths.dbPath)}`);
    printLine(context);
    printLine(context, 'Next: edit config/sources.yaml, then run `roleeye scan`.');
    printLine(context, 'Or run `roleeye init --interactive` to be asked a few questions instead.');

    return ExitCode.Ok;
}
