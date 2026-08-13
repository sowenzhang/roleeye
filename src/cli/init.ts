import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ExitCode } from '../util/errors.js';
import { openDatabase } from '../db/database.js';
import { resolvePaths } from '../config/paths.js';
import { flagBool } from './args.js';
import { printJson, printLine, type Command, type CommandContext } from './command.js';

interface CopyPlan {
  from: string;
  to: string;
}

const CONFIG_FILES = ['criteria', 'sources', 'sync'] as const;
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
  summary: 'Create local config/profile files from the committed examples',
  usage: 'roleeye init [--force] [--json]',

  run(context: CommandContext) {
    const paths = resolvePaths(context.root);
    const force = flagBool(context.args, 'force');

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

    return ExitCode.Ok;
  },
};
